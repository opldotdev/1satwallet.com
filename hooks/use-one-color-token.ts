"use client";

import { useQuery } from "@tanstack/react-query";
import {
	oneColorBalancesQueryKey,
	useOneColorBalances,
} from "@/hooks/use-one-color-balances";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import {
	getOneColorAssetInfo,
	NotOneColorDeployError,
	type OneColorAssetInfo,
	type OneColorBalance,
} from "@/lib/wallet/one-color";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

export type OneColorTokenState =
	| { kind: "loading" }
	| { kind: "ready"; token: OneColorBalance }
	/** A well-formed id whose output is not a 1Color deploy. */
	| { kind: "not-a-token" }
	| { kind: "error" };

type QueryLike<T> = {
	status: "pending" | "error" | "success";
	data: T | undefined;
	error: unknown;
};

/**
 * What the token page shows. The holding when the wallet has one, else zero
 * balances with the deploy's display fields (a token sent away in full still
 * has a history). A failed holdings read is an error even though the deploy
 * read never ran: that read waits on the holdings and would stay pending.
 */
export const oneColorTokenState = (
	assetId: string,
	balances: QueryLike<OneColorBalance[]>,
	info: QueryLike<OneColorAssetInfo>,
): OneColorTokenState => {
	if (balances.status === "error") return { kind: "error" };
	if (balances.status === "pending") return { kind: "loading" };
	const held = balances.data?.find((t) => t.assetId === assetId);
	if (held) return { kind: "ready", token: held };
	if (info.status === "error")
		return info.error instanceof NotOneColorDeployError
			? { kind: "not-a-token" }
			: { kind: "error" };
	if (info.status === "pending" || !info.data) return { kind: "loading" };
	return {
		kind: "ready",
		token: {
			assetId,
			available: 0n,
			pending: 0n,
			authorities: 0,
			...info.data,
		},
	};
};

/** The token page's asset: see `oneColorTokenState`. */
export function useOneColorToken(assetId: string) {
	const { chain, identityKey, services } = useWalletToolbox();
	const balances = useOneColorBalances();
	const held = balances.data?.some((t) => t.assetId === assetId) ?? false;
	const info = useQuery({
		queryKey: [
			...oneColorBalancesQueryKey(chain, identityKey),
			"asset",
			assetId,
		],
		enabled: balances.isSuccess && !held,
		retry: (failures, error) =>
			!(error instanceof NotOneColorDeployError) && failures < 3,
		queryFn: async () => {
			try {
				return await getOneColorAssetInfo(
					{ chain, services: services ?? undefined },
					assetId,
				);
			} catch (error) {
				console.error(`[1color] deploy of ${assetId} not readable:`, error);
				if (!(error instanceof NotOneColorDeployError))
					reportDiagnostic({
						category: "provider",
						code: "provider.failed",
						operation: "wallet.1color.asset-info",
						recoverable: true,
						context: { retryable: true },
					});
				throw error;
			}
		},
	});
	return {
		state: oneColorTokenState(assetId, balances, info),
		retry: () => {
			if (balances.isError) void balances.refetch();
			else void info.refetch();
		},
	};
}
