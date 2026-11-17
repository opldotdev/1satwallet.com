"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { MigrationSweepFlow } from "@/components/wallet/migration-sections";
import { useBsv20ContentLabels } from "@/lib/hooks/use-bsv20-content";
import { useLegacyAssets } from "@/lib/hooks/use-legacy-assets";
import { deriveIdentityKey } from "@/lib/keys";
import {
	emptySweepResult,
	executeMigrationSweep,
	type SweepProgress,
	type SweepResult,
} from "@/lib/sweep-migration";
import {
	ListingCancelError,
	type MigrationTarget,
	partialRunResult,
	requireMigrationTarget,
	runFirstRunMigration,
	runMigrationOnTarget,
} from "@/lib/wallet/first-run-migration";
import {
	countSweepableLegacyAssets,
	decideScanPhase,
} from "@/lib/wallet/legacy-scan-state";
import {
	type AssetType,
	cancelListedAssets,
	defaultAssetTypes,
	listedFromLegacy,
	listedFromWallet,
	mergeListed,
	onlyListedTokens,
	planMigration,
	plannedCount,
	toggleAssetType,
	tokenOutputCount,
	withoutListed,
} from "@/lib/wallet/migration-listings";
import {
	buildSweepSummary,
	sweepScreenFor,
	type WizardStepId,
} from "@/lib/wallet/sweep-summary";
import {
	detectMigrationStatus,
	type MigrationStatus,
	reportMigrationFailure,
} from "@/lib/wallet-migration";
import { reencryptWallet } from "@/lib/wallet-storage";
import { useWallet } from "@/providers/wallet-provider";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

type MigrationPhase = "scan" | "preview" | "migrate" | "complete" | "error";

/** The finished screen's primary action; a rescan is always offered. */
function rescanLabelFor(
	sweepResult: SweepResult | null,
	remaining: number,
): string {
	const hadErrors = (sweepResult?.errors.length ?? 0) > 0;
	return hadErrors
		? "Rescan & Retry Failed Sweeps"
		: remaining > 0
			? `Sweep Remaining ${remaining} ${remaining === 1 ? "Item" : "Items"}`
			: "Scan Legacy Addresses Again";
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function MigratePage() {
	const router = useRouter();
	const { walletKeys, isWalletLocked } = useWallet();
	const toolbox = useWalletToolbox();

	const [phase, setPhase] = useState<MigrationPhase>("scan");
	const [progress, setProgress] = useState("");
	const [progressPercent, setProgressPercent] = useState(0);
	const [sweepProgress, setSweepProgress] = useState<SweepProgress | null>(
		null,
	);
	const [scanDetail, setScanDetail] = useState<string | null>(null);
	const [sweepResult, setSweepResult] = useState<SweepResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Ordinal selection state
	const [selectedOrdinals, setSelectedOrdinals] = useState<Set<string>>(
		new Set(),
	);
	const [selectedTypes, setSelectedTypes] = useState<Set<AssetType>>(() =>
		defaultAssetTypes(),
	);

	// Detect migration status
	const migrationStatus: MigrationStatus | null = useMemo(() => {
		if (!walletKeys || isWalletLocked) return null;
		return detectMigrationStatus(walletKeys);
	}, [walletKeys, isWalletLocked]);

	// Legacy key material is available in both the "legacy" (pre-migration)
	// and "migrated" (sweep-only re-entry) states
	const legacy = useMemo(() => {
		if (!migrationStatus) return null;
		if (migrationStatus.status === "legacy") {
			return {
				sweepOnly: false,
				payWif: migrationStatus.legacyPayWif,
				ordWif: migrationStatus.legacyOrdWif,
				identityWif: undefined as string | undefined,
				payAddress: migrationStatus.legacyPayAddress,
				ordAddress: migrationStatus.legacyOrdAddress,
				identityAddress: undefined as string | undefined,
			};
		}
		if (
			migrationStatus.status === "migrated" &&
			migrationStatus.legacyPayWif &&
			migrationStatus.legacyOrdWif
		) {
			return {
				sweepOnly: true,
				payWif: migrationStatus.legacyPayWif,
				ordWif: migrationStatus.legacyOrdWif,
				identityWif: migrationStatus.legacyIdentityWif,
				payAddress: migrationStatus.legacyPayAddress ?? null,
				ordAddress: migrationStatus.legacyOrdAddress ?? null,
				identityAddress: migrationStatus.legacyIdentityAddress,
			};
		}
		return null;
	}, [migrationStatus]);

	const assets = useLegacyAssets(
		toolbox.connectionMode === "external" ? null : (legacy?.payAddress ?? null),
		toolbox.connectionMode === "external" ? null : (legacy?.ordAddress ?? null),
		toolbox.connectionMode === "external"
			? null
			: (legacy?.identityAddress ?? null),
		(p) => setScanDetail(p.detail ?? p.phase),
	);

	const listings = useMemo(
		() =>
			mergeListed(
				listedFromWallet(toolbox.ordinals),
				listedFromLegacy([
					...assets.ordinals,
					...assets.opnsNames,
					...assets.locked,
					...assets.run,
					...assets.listings,
				]),
			),
		[
			toolbox.ordinals,
			assets.ordinals,
			assets.opnsNames,
			assets.locked,
			assets.run,
			assets.listings,
		],
	);
	const unlistedOrdinals = useMemo(
		() => withoutListed(assets.ordinals),
		[assets.ordinals],
	);
	const unlistedOpns = useMemo(
		() => withoutListed(assets.opnsNames),
		[assets.opnsNames],
	);
	const unlistedLocked = useMemo(
		() => withoutListed(assets.locked),
		[assets.locked],
	);
	const unlistedRun = useMemo(() => withoutListed(assets.run), [assets.run]);
	const listedLegacyOutputs = useMemo(
		() => [
			...assets.ordinals.filter((item) =>
				listings.some(
					(listing) =>
						listing.outpoint === item.outpoint && listing.source === "legacy",
				),
			),
			...assets.opnsNames.filter((item) =>
				listings.some(
					(listing) =>
						listing.outpoint === item.outpoint && listing.source === "legacy",
				),
			),
		],
		[assets.ordinals, assets.opnsNames, listings],
	);

	const selectedUnlisted = useMemo(
		() =>
			unlistedOrdinals.filter((item) => selectedOrdinals.has(item.outpoint)),
		[unlistedOrdinals, selectedOrdinals],
	);

	const plan = useMemo(
		() =>
			planMigration({
				types: selectedTypes,
				listings,
				listedLegacyOutputs,
				ordinals: selectedUnlisted,
				opns: selectedTypes.has("ordinals") ? unlistedOpns : [],
				funding: assets.funding,
				bsv21: assets.bsv21Tokens,
				bsv20: assets.bsv20Balances,
			}),
		[
			selectedTypes,
			listings,
			listedLegacyOutputs,
			selectedUnlisted,
			unlistedOpns,
			assets.funding,
			assets.bsv21Tokens,
			assets.bsv20Balances,
		],
	);

	// Sweepable asset counts (opns names sweep together with ordinals)
	const totalAssets = plannedCount(plan);

	// Same count as the sidebar banner: being migrated never hides assets the
	// scan still finds at the legacy addresses.
	const sweepableLegacy = countSweepableLegacyAssets(assets);

	// Transition from scan once the scan of the current legacy addresses has
	// finished. Nothing is ever shown as "already migrated" before that.
	useEffect(() => {
		if (!migrationStatus) return;
		if (phase !== "scan") return;
		if (assets.error) return;

		const decision = decideScanPhase({
			hasLegacyKeys: legacy !== null,
			migrated: migrationStatus.status === "migrated",
			scanned: assets.scanned,
			loading: assets.loading,
			balanceLoading: toolbox.isBalanceLoading,
			sweepable: sweepableLegacy,
			listings: listings.length,
		});
		if (decision === "wait") return;
		if (decision === "missing-keys") {
			setError("Wallet cannot be migrated (missing pay or ord key)");
			setPhase("error");
			return;
		}
		setPhase(decision === "preview" ? "preview" : "complete");
	}, [
		migrationStatus,
		legacy,
		phase,
		assets.scanned,
		assets.loading,
		assets.error,
		sweepableLegacy,
		listings.length,
		toolbox.isBalanceLoading,
	]);

	// A finished page that swept nothing reopens if a rescan finds assets.
	useEffect(() => {
		if (phase !== "complete" || sweepResult) return;
		if (assets.loading || !assets.scanned) return;
		if (sweepableLegacy > 0 || listings.length > 0) setPhase("preview");
	}, [
		phase,
		sweepResult,
		assets.loading,
		assets.scanned,
		sweepableLegacy,
		listings.length,
	]);

	// Select every unlisted ordinal by default, once per scan result, so a
	// deliberate "Deselect all" stays deselected.
	const defaultedOrdinals = useRef<typeof unlistedOrdinals | null>(null);
	useEffect(() => {
		if (defaultedOrdinals.current === unlistedOrdinals) return;
		defaultedOrdinals.current = unlistedOrdinals;
		setSelectedOrdinals(new Set(unlistedOrdinals.map((item) => item.outpoint)));
	}, [unlistedOrdinals]);

	// Ordinal selection handlers
	const handleToggleOrdinal = useCallback((outpoint: string) => {
		setSelectedOrdinals((prev) => {
			const next = new Set(prev);
			if (next.has(outpoint)) {
				next.delete(outpoint);
			} else {
				next.add(outpoint);
			}
			return next;
		});
	}, []);

	const handleSelectAll = useCallback(() => {
		setSelectedOrdinals(new Set(unlistedOrdinals.map((item) => item.outpoint)));
	}, [unlistedOrdinals]);

	const handleDeselectAll = useCallback(() => {
		setSelectedOrdinals(new Set());
	}, []);

	const handleToggleType = useCallback((type: AssetType) => {
		setSelectedTypes((prev) => toggleAssetType(prev, type));
	}, []);

	// Ordinals to sweep: selected unlisted, OpNS, and listed leftovers
	const sweepOrdinals = useMemo(() => {
		return [...plan.sweepOrdinals, ...plan.sweepListed];
	}, [plan.sweepOrdinals, plan.sweepListed]);

	const runDelist = useCallback(async () => {
		if (!toolbox.oneSatContext || plan.cancel.length === 0) {
			return { ok: true, txids: [] as string[], errors: [] as string[] };
		}
		setProgress("Cancelling listings...");
		return cancelListedAssets(toolbox.oneSatContext, plan.cancel);
	}, [toolbox.oneSatContext, plan.cancel]);

	const runDelistOnly = useCallback(async () => {
		if (!toolbox.oneSatContext) {
			setError("Unlock your wallet to cancel listings.");
			setPhase("error");
			return;
		}
		setPhase("migrate");
		setError(null);
		setProgressPercent(20);
		setSweepProgress(null);
		try {
			const cancelled = await runDelist();
			if (!cancelled.ok) {
				console.error("[migration] listing cancel failed", cancelled.errors);
				setSweepResult(
					emptySweepResult({
						cancelTxids: cancelled.txids,
						errors: cancelled.errors,
					}),
				);
				setError(
					`${
						new ListingCancelError(
							plan.cancel.length,
							cancelled.txids,
							cancelled.errors,
						).message
					} Nothing else was moved.`,
				);
				setPhase("error");
				return;
			}
			let result: SweepResult = emptySweepResult({
				cancelTxids: cancelled.txids,
			});
			const listedBsv21 = onlyListedTokens(assets.bsv21Tokens);
			const listedBsv20 = onlyListedTokens(assets.bsv20Balances);
			if (
				legacy &&
				plan.sweepListed.length +
					tokenOutputCount(listedBsv21) +
					tokenOutputCount(listedBsv20) >
					0
			) {
				const target = requireMigrationTarget(toolbox);
				setProgress("Returning listed assets to the wallet...");
				setProgressPercent(50);
				result = await executeMigrationSweep({
					wallet: target.wallet,
					services: target.services,
					chain: toolbox.chain,
					legacyPayWif: legacy.payWif,
					legacyOrdWif: legacy.ordWif,
					legacyIdentityWif: legacy.identityWif,
					onProgress: (p) => {
						setProgress(p.message);
						setProgressPercent(50 + Math.round((p.percent / 100) * 50));
						setSweepProgress(p);
					},
					funding: [],
					ordinals: plan.sweepListed,
					bsv21Tokens: listedBsv21,
					bsv20Tokens: listedBsv20,
				});
				result = { ...result, cancelTxids: cancelled.txids };
			}
			if (result.errors.length > 0) {
				console.error(
					"[migration] listing return finished with errors",
					result.errors,
				);
			}
			setSweepResult(result);
			assets.rescan();
			toolbox.refreshBalance();
			setProgressPercent(100);
			setPhase("complete");
		} catch (err) {
			reportMigrationFailure("wallet.migration.delist", err);
			setError(err instanceof Error ? err.message : String(err));
			setPhase("error");
		}
	}, [
		assets,
		legacy,
		plan.cancel.length,
		plan.sweepListed,
		runDelist,
		toolbox,
	]);

	// Run migration (or sweep-only re-entry for already-migrated wallets)
	const runMigration = useCallback(async () => {
		if (!walletKeys || !legacy) return;

		setPhase("migrate");
		setError(null);
		setProgressPercent(0);
		setSweepProgress(null);

		try {
			const sweepInto = (
				target: MigrationTarget,
				identityWif: string | undefined,
			) => {
				const totalSweepable =
					plan.sweepFunding.length +
					sweepOrdinals.length +
					tokenOutputCount(plan.sweepBsv21) +
					tokenOutputCount(plan.sweepBsv20);
				if (totalSweepable === 0) return Promise.resolve(null);
				setProgress(
					`Sweeping ${totalSweepable} asset${totalSweepable !== 1 ? "s" : ""}...`,
				);
				// Pre-sweep stages (key derivation, re-encryption, re-init) span
				// 0-60%; the sweep's own unit-based percent fills the rest. For a
				// sweep-only re-entry the sweep owns the whole bar.
				const base = legacy.sweepOnly ? 0 : 60;
				const span = 100 - base;
				setProgressPercent(base);
				return executeMigrationSweep({
					wallet: target.wallet,
					services: target.services,
					chain: toolbox.chain,
					legacyPayWif: legacy.payWif,
					legacyOrdWif: legacy.ordWif,
					legacyIdentityWif: identityWif,
					onProgress: (p) => {
						setProgress(p.message);
						setProgressPercent(base + Math.round((p.percent / 100) * span));
						setSweepProgress(p);
					},
					funding: plan.sweepFunding,
					ordinals: sweepOrdinals,
					bsv21Tokens: plan.sweepBsv21,
					bsv20Tokens: plan.sweepBsv20,
				});
			};
			const onStage = (stage: string) => {
				if (stage === "cancel") setProgress("Cancelling listings...");
				else if (stage === "transfer") {
					setProgress("Moving this wallet's assets to your identity key...");
					setProgressPercent(20);
				} else if (stage === "persist") {
					setProgress("Updating encrypted wallet...");
					setProgressPercent(25);
				} else if (stage === "reroot") {
					setProgress("Reinitializing BRC-100 wallet...");
					setProgressPercent(40);
				}
			};

			let run: Awaited<ReturnType<typeof runMigrationOnTarget>>;
			if (legacy.sweepOnly) {
				run = await runMigrationOnTarget(requireMigrationTarget(toolbox), {
					listings: plan.cancel,
					sweep: (target) => sweepInto(target, legacy.identityWif),
					onStage,
				});
			} else {
				setProgress("Deriving identity key...");
				setProgressPercent(10);
				const identityWif = deriveIdentityKey(
					legacy.payWif,
					legacy.ordWif,
				).toWif();
				const updatedKeys = {
					...walletKeys,
					identityPk: identityWif,
					identityAddressPath: "derived" as string | number | undefined,
				};
				// `toolbox` is this render's snapshot: after the re-root it still
				// points at the destroyed pay-key wallet, so the sweep uses the
				// wallet runFirstRunMigration hands back.
				run = await runFirstRunMigration({
					current: toolbox,
					listings: plan.cancel,
					identityWif,
					isInitialized: toolbox.isInitialized,
					destroyWallet: toolbox.destroyWallet,
					initializeWallet: toolbox.initializeWallet,
					persistIdentity: async () => {
						if (!(await reencryptWallet(updatedKeys))) {
							throw new Error(
								"Failed to re-encrypt wallet. Try unlocking your wallet again first.",
							);
						}
					},
					sweep: (target) => sweepInto(target, identityWif),
					onStage,
				});
			}

			if (run.sweep && run.sweep.errors.length > 0) {
				console.error(
					"[migration] sweep finished with errors",
					run.sweep.errors,
				);
			}
			setSweepResult({
				...(run.sweep ?? emptySweepResult()),
				cancelTxids: run.cancelTxids,
				transferTxids: run.transferTxids,
			});
			if (run.sweep || run.transferTxids.length > 0) {
				// Refresh so the banner and any re-entry reflect what's left
				assets.rescan();
				toolbox.refreshBalance();
			}

			setProgressPercent(100);
			setPhase("complete");
		} catch (err) {
			reportMigrationFailure("wallet.migration.run", err);
			const partial = partialRunResult(err);
			if (partial) setSweepResult(emptySweepResult(partial));
			setError(err instanceof Error ? err.message : String(err));
			setPhase("error");
		}
	}, [
		walletKeys,
		legacy,
		toolbox,
		assets,
		sweepOrdinals,
		plan.cancel,
		plan.sweepFunding,
		plan.sweepBsv21,
		plan.sweepBsv20,
	]);

	// What the wizard shows. Display only: the plan above decides what moves.
	const summary = useMemo(
		() =>
			buildSweepSummary({
				funding: assets.funding,
				totalBsv: assets.totalBsv,
				ordinals: unlistedOrdinals,
				opnsNames: unlistedOpns,
				bsv21Tokens: assets.bsv21Tokens,
				bsv20Balances: assets.bsv20Balances,
				listings: listings.length,
				bsv20Unsweepable: assets.bsv20Unsweepable,
				locked: unlistedLocked,
				run: unlistedRun,
			}),
		[
			assets.funding,
			assets.totalBsv,
			unlistedOrdinals,
			unlistedOpns,
			assets.bsv21Tokens,
			assets.bsv20Balances,
			listings.length,
			assets.bsv20Unsweepable,
			unlistedLocked,
			unlistedRun,
		],
	);
	const [wizardStep, setWizardStep] = useState<WizardStepId | null>(null);
	// Labels for the BSV-20 inscriptions that stay put, read only while that
	// step is on screen. Never part of the sweep.
	const bsv20Display = useBsv20ContentLabels(summary.bsv20Unconfirmed, {
		enabled: wizardStep === "stays",
	});

	if (toolbox.connectionMode === "external") {
		return (
			<section className="space-y-6">
				<div>
					<Card>
						<CardContent className="py-8 text-center text-muted-foreground">
							Migration is available only for the wallet built into this
							browser.
						</CardContent>
					</Card>
				</div>
			</section>
		);
	}

	// Locked state
	if (isWalletLocked || !walletKeys) {
		return (
			<section className="space-y-6">
				<div>
					<Card>
						<CardContent className="py-8 text-center text-muted-foreground">
							Unlock your wallet to check migration status.
						</CardContent>
					</Card>
				</div>
			</section>
		);
	}

	const retryScan = () => {
		setSweepResult(null);
		setSweepProgress(null);
		setScanDetail(null);
		setPhase("scan");
		assets.rescan();
	};

	return (
		<MigrationSweepFlow
			variant="page"
			screen={sweepScreenFor(phase === "error" && !error ? "preview" : phase)}
			firstRun={legacy ? !legacy.sweepOnly : false}
			canSweep={legacy !== null}
			scanDetail={scanDetail}
			scanError={assets.error}
			onRetryScan={assets.rescan}
			summary={summary}
			ordinals={unlistedOrdinals}
			selectedOrdinals={selectedOrdinals}
			onToggleOrdinal={handleToggleOrdinal}
			onSelectAllOrdinals={handleSelectAll}
			onDeselectAllOrdinals={handleDeselectAll}
			selectedTypes={selectedTypes}
			onToggleType={handleToggleType}
			plannedTotal={totalAssets}
			onSweep={() => void runMigration()}
			onCancelListingsOnly={() => void runDelistOnly()}
			progressMessage={progress}
			progressPercent={progressPercent}
			sweepProgress={sweepProgress}
			sweepResult={sweepResult}
			remaining={assets.scanned && !assets.loading ? sweepableLegacy : 0}
			doneLabel={(remaining) => rescanLabelFor(sweepResult, remaining)}
			onDone={retryScan}
			doneSecondary={{
				label: "Back to wallet",
				onClick: () => router.push("/wallet"),
			}}
			error={error}
			onTryAgain={() => setPhase("preview")}
			errorSecondary={{
				label: "Back to wallet",
				onClick: () => router.push("/wallet"),
			}}
			addresses={[
				...(legacy?.payAddress
					? [{ label: "Old pay address", address: legacy.payAddress }]
					: []),
				...(legacy?.ordAddress
					? [{ label: "Old ordinals address", address: legacy.ordAddress }]
					: []),
				...(legacy?.identityAddress
					? [{ label: "Old identity address", address: legacy.identityAddress }]
					: []),
			]}
			destination="This wallet (your identity key)"
			bsv20={bsv20Display}
			onStepChange={setWizardStep}
		/>
	);
}
