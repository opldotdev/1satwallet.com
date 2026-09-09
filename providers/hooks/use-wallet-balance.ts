"use client";

import {
	type Bsv21Balance,
	getBsv21Balances,
	type OneSatContext,
	type WalletOutput,
} from "@1sat/actions";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import {
	type AssetSurfaceState,
	assetSurfaceFromCount,
	shouldQueryAssetSurface,
} from "@/lib/wallet/asset-query-state";
import { listOrdinalInventory } from "@/lib/wallet/ordinal-inventory";
import type { CapabilityState } from "@/lib/wallet/provider-capabilities";

interface WalletBalance {
	confirmed: number;
	unconfirmed: number;
	total: number;
}

// Wallet Toolbox's BRC-100 balance pseudo-basket. Kept local because the
// client package intentionally does not expose its internal SDK constants.
const WALLET_BALANCE_BASKET =
	"893b7646de0e1c9f741bd6e9169b76a8847ae34adef7bef1e6a285371206d2e8";

interface LegacyFundingUtxo {
	outpoint: string;
	satoshis: number;
}

interface BalanceQueryResult {
	balance: WalletBalance | null;
	balanceFailed: boolean;
	ordinals: WalletOutput[];
	bsv21Balances: Bsv21Balance[];
	legacyBalance: number;
	legacyFundingUtxos: LegacyFundingUtxo[];
	ordinalsState: AssetSurfaceState;
	bsv21State: AssetSurfaceState;
}

interface UseWalletBalanceOptions {
	ctx: OneSatContext | null;
	isInitialized: boolean;
	identityKey: string | null;
	trackedAddresses: string[];
	includeLegacyFunding: boolean;
	assetRead: CapabilityState;
}

interface SyncStatus {
	isSyncing: boolean;
	progress: null;
	lastSync: Date | null;
	error: string | null;
}

export interface WalletBalanceResult {
	balance: WalletBalance | null;
	ordinals: WalletOutput[];
	bsv21Balances: Bsv21Balance[];
	legacyBalance: number;
	legacyFundingUtxos: LegacyFundingUtxo[];
	ordinalsState: AssetSurfaceState;
	bsv21State: AssetSurfaceState;
	isBalanceLoading: boolean;
	balanceError: Error | null;
	refreshBalance: () => void;
	syncStatus: SyncStatus;
	balanceQueryKey: readonly [
		string,
		string,
		string | null,
		string,
		boolean,
		CapabilityState,
	];
}

export function useWalletBalance({
	ctx,
	isInitialized,
	identityKey,
	trackedAddresses,
	includeLegacyFunding,
	assetRead,
}: UseWalletBalanceOptions): WalletBalanceResult {
	const queryClient = useQueryClient();

	const chain = ctx?.chain ?? "main";

	const addressesKey = useMemo(
		() => trackedAddresses.join(","),
		[trackedAddresses],
	);
	const balanceQueryKey = useMemo(
		() =>
			[
				"wallet-balance",
				chain,
				identityKey,
				addressesKey,
				includeLegacyFunding,
				assetRead,
			] as const,
		[chain, identityKey, addressesKey, includeLegacyFunding, assetRead],
	);

	const balanceQuery = useQuery({
		queryKey: balanceQueryKey,
		queryFn: async (): Promise<BalanceQueryResult> => {
			if (!ctx || !isInitialized || trackedAddresses.length === 0) {
				throw new Error("Wallet not initialized");
			}

			// Legacy balance hint from the stack index (display-only — the
			// migrate flow does its own forced re-sync before sweeping).
			// Funding = plain sats>1 outputs without token/lock event tags.
			const legacyResultsPromise = includeLegacyFunding
				? Promise.all(
						trackedAddresses.map(async (address) => {
							try {
								const outputs =
									(await ctx.services?.txo.search(`own:${address}`, {
										unspent: true,
										events: true,
										sats: true,
										limit: 0,
									})) ?? [];
								return outputs.filter((out) => {
									const events = out.events ?? [];
									if ((out.satoshis ?? 0) <= 1) return false;
									return !events.some(
										(e) =>
											e.startsWith("bsv21:") ||
											e.startsWith("lock:") ||
											e === "type:application/bsv-20" ||
											e === "type:Token",
									);
								});
							} catch {
								reportDiagnostic({
									category: "provider",
									code: "provider.failed",
									operation: "wallet.balance.legacy-scan",
									recoverable: true,
									context: { retryable: true },
								});
								return [];
							}
						}),
					)
				: Promise.resolve([]);

			const readAssets = shouldQueryAssetSurface(assetRead);
			const [legacyResults, balanceResult, ordinalsResult, bsv21Result] =
				await Promise.all([
					legacyResultsPromise,
					ctx.wallet.listOutputs({ basket: WALLET_BALANCE_BASKET }).then(
						(result) => ({ ok: true as const, result }),
						(error: unknown) => ({ ok: false as const, error }),
					),
					readAssets
						? listOrdinalInventory(ctx).then(
								(outputs) => ({
									ok: true as const,
									result: { outputs },
								}),
								(error: unknown) => ({ ok: false as const, error }),
							)
						: Promise.resolve({
								ok: false as const,
								skipped: true as const,
							}),
					readAssets
						? getBsv21Balances.execute(ctx, {}).then(
								(result) => ({ ok: true as const, result }),
								(error: unknown) => ({ ok: false as const, error }),
							)
						: Promise.resolve({
								ok: false as const,
								skipped: true as const,
							}),
				]);

			if (!balanceResult.ok) {
				reportDiagnostic({
					category: "provider",
					code: "provider.failed",
					operation: "wallet.balance.list-outputs",
					recoverable: true,
					context: { retryable: true },
				});
			}

			const total = balanceResult.ok ? balanceResult.result.totalOutputs : 0;
			const ordinals = ordinalsResult.ok ? ordinalsResult.result.outputs : [];
			const bsv21Balances = bsv21Result.ok ? bsv21Result.result : [];
			const ordinalsState: AssetSurfaceState = !readAssets
				? { kind: "unsupported", capability: assetRead }
				: ordinalsResult.ok
					? assetSurfaceFromCount(ordinals.length)
					: { kind: "error", message: "Couldn't load. Try again." };
			const bsv21State: AssetSurfaceState = !readAssets
				? { kind: "unsupported", capability: assetRead }
				: bsv21Result.ok
					? assetSurfaceFromCount(bsv21Balances.length)
					: { kind: "error", message: "Couldn't load. Try again." };
			if (ordinalsState.kind === "error" || bsv21State.kind === "error") {
				reportDiagnostic({
					category: "provider",
					code: "provider.failed",
					operation: "wallet.balance.asset-read",
					recoverable: true,
					context: { retryable: true, capability: assetRead },
				});
			}

			const legacyFundingUtxos = legacyResults.flat().map((u) => ({
				outpoint: u.outpoint,
				satoshis: u.satoshis ?? 0,
			}));
			const legacyBalance = legacyFundingUtxos.reduce(
				(sum, u) => sum + u.satoshis,
				0,
			);

			return {
				balance: balanceResult.ok
					? { confirmed: total, unconfirmed: 0, total }
					: null,
				balanceFailed: !balanceResult.ok,
				ordinals,
				bsv21Balances,
				legacyBalance,
				legacyFundingUtxos,
				ordinalsState,
				bsv21State,
			};
		},
		enabled: isInitialized && !!ctx && trackedAddresses.length > 0,
		staleTime: 30_000,
		gcTime: 5 * 60_000,
	});

	const refreshBalance = useCallback(() => {
		queryClient.invalidateQueries({
			queryKey: ["wallet-balance", chain, identityKey],
		});
	}, [queryClient, chain, identityKey]);

	const [lastSync, setLastSync] = useState<Date | null>(null);
	const wasFetchingRef = useRef(false);
	useEffect(() => {
		if (
			wasFetchingRef.current &&
			!balanceQuery.isFetching &&
			balanceQuery.isSuccess
		) {
			setLastSync(new Date());
		}
		wasFetchingRef.current = balanceQuery.isFetching;
	}, [balanceQuery.isFetching, balanceQuery.isSuccess]);

	const syncStatus = useMemo<SyncStatus>(
		() => ({
			isSyncing: balanceQuery.isFetching,
			progress: null,
			lastSync,
			error: balanceQuery.data?.balanceFailed
				? "Balance refresh failed. Try again."
				: balanceQuery.error
					? "Balance refresh failed. Try again."
					: null,
		}),
		[
			balanceQuery.isFetching,
			balanceQuery.error,
			lastSync,
			balanceQuery.data?.balanceFailed,
		],
	);

	const unsupportedAssets: AssetSurfaceState = {
		kind: "unsupported",
		capability: assetRead,
	};

	return {
		balance: balanceQuery.data?.balance ?? null,
		ordinals: balanceQuery.data?.ordinals ?? [],
		bsv21Balances: balanceQuery.data?.bsv21Balances ?? [],
		legacyBalance: balanceQuery.data?.legacyBalance ?? 0,
		legacyFundingUtxos: balanceQuery.data?.legacyFundingUtxos ?? [],
		ordinalsState: balanceQuery.data?.ordinalsState ?? unsupportedAssets,
		bsv21State: balanceQuery.data?.bsv21State ?? unsupportedAssets,
		isBalanceLoading: balanceQuery.isLoading,
		balanceError:
			balanceQuery.data?.balanceFailed || balanceQuery.error
				? new Error("Balance refresh failed. Try again.")
				: null,
		refreshBalance,
		syncStatus,
		balanceQueryKey,
	};
}
