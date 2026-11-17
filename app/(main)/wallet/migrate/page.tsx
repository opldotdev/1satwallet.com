"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Bsv20Section,
	FundingSection,
	ListingsSection,
	LockedSection,
	OpnsSection,
	OrdinalsSection,
	RunSection,
	SweepResultRows,
	SweepStepsList,
	sweepResultIsEmpty,
	TokensSection,
	TypeChecklist,
} from "@/components/wallet/migration-sections";
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
	detectMigrationStatus,
	type MigrationStatus,
	reportMigrationFailure,
} from "@/lib/wallet-migration";
import { reencryptWallet } from "@/lib/wallet-storage";
import { useWallet } from "@/providers/wallet-provider";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

type MigrationPhase = "scan" | "preview" | "migrate" | "complete" | "error";
const SCANNING_SKELETON_KEYS = [
	"scan-card-1",
	"scan-card-2",
	"scan-card-3",
	"scan-card-4",
	"scan-card-5",
	"scan-card-6",
] as const;

// ---------------------------------------------------------------------------
// Scanning skeleton
// ---------------------------------------------------------------------------

function ScanningState({ scanDetail }: { scanDetail: string | null }) {
	return (
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<CardTitle>Scanning Legacy Addresses</CardTitle>
					<CardDescription className="animate-pulse">
						{scanDetail ??
							"Looking for BSV, ordinals and tokens at your legacy addresses..."}
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<Skeleton className="h-16 w-full" />
					<div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
						{SCANNING_SKELETON_KEYS.map((key) => (
							<Skeleton key={key} className="aspect-square w-full" />
						))}
					</div>
					<Skeleton className="h-12 w-full" />
				</CardContent>
			</Card>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Migration Progress
// ---------------------------------------------------------------------------

function MigrationProgress({
	progress,
	progressPercent,
	sweepProgress,
}: {
	progress: string;
	progressPercent: number;
	sweepProgress: SweepProgress | null;
}) {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Migrating</CardTitle>
				<CardDescription>
					Do not close this page or lock your wallet.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<Progress value={progressPercent} />
				<div className="text-sm text-muted-foreground animate-pulse">
					{progress}
				</div>
				{sweepProgress && <SweepStepsList steps={sweepProgress.steps} />}
			</CardContent>
		</Card>
	);
}

// ---------------------------------------------------------------------------
// Completion State
// ---------------------------------------------------------------------------

function CompletionState({
	sweepResult,
	remaining,
	onBackToWallet,
	onRetryFailed,
}: {
	sweepResult: SweepResult | null;
	remaining: number;
	onBackToWallet: () => void;
	onRetryFailed: () => void;
}) {
	const hadErrors = (sweepResult?.errors.length ?? 0) > 0;
	const rescanLabel = hadErrors
		? "Rescan & Retry Failed Sweeps"
		: remaining > 0
			? `Sweep Remaining ${remaining} ${remaining === 1 ? "Item" : "Items"}`
			: "Scan Legacy Addresses Again";
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					{sweepResult
						? hadErrors
							? "Sweep Finished With Errors"
							: "Migration Complete"
						: "Nothing Left to Sweep"}
				</CardTitle>
				<CardDescription>
					{sweepResult
						? hadErrors
							? "Some assets could not be swept. You can rescan and retry the remainder — successfully swept assets are already safe in your wallet."
							: "Your wallet has been migrated to the identity key system."
						: "A fresh scan found nothing left to sweep at your legacy addresses. You can scan again at any time."}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{sweepResult && (
					<div className="space-y-2 text-sm">
						<SweepResultRows
							result={sweepResult}
							rowClassName="flex justify-between"
						/>
						{sweepResult.errors.length > 0 && (
							<div className="space-y-1">
								<p className="text-sm font-medium text-destructive">
									Some sweeps had errors:
								</p>
								{sweepResult.errors.map((err) => (
									<p key={err} className="text-xs text-destructive/80">
										{err}
									</p>
								))}
							</div>
						)}
						{sweepResultIsEmpty(sweepResult) && (
							<p className="text-sm text-muted-foreground">
								No assets found at legacy addresses.
							</p>
						)}
					</div>
				)}
				{sweepResult && remaining > 0 && (
					<p className="text-sm text-muted-foreground">
						{remaining} {remaining === 1 ? "item is" : "items are"} still at
						your legacy addresses.
					</p>
				)}
				<Button className="w-full" onClick={onRetryFailed}>
					{rescanLabel}
				</Button>
				<Button variant="outline" className="w-full" onClick={onBackToWallet}>
					Back to Wallet
				</Button>
			</CardContent>
		</Card>
	);
}

// ---------------------------------------------------------------------------
// Error State
// ---------------------------------------------------------------------------

function ErrorState({
	error,
	onRetry,
	onBack,
}: {
	error: string;
	onRetry: () => void;
	onBack: () => void;
}) {
	return (
		<Card className="border-destructive/50">
			<CardHeader>
				<CardTitle className="text-destructive">Migration Error</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				<p className="text-sm text-destructive">{error}</p>
				<div className="flex gap-2">
					<Button variant="outline" onClick={onRetry}>
						Retry
					</Button>
					<Button variant="outline" onClick={onBack}>
						Back to Wallet
					</Button>
				</div>
			</CardContent>
		</Card>
	);
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
	const [ordinalPage, setOrdinalPage] = useState(0);
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

	const typeCounts = useMemo(
		() => ({
			listings: listings.length,
			ordinals: unlistedOrdinals.length + unlistedOpns.length,
			bsv21: tokenOutputCount(assets.bsv21Tokens),
			bsv20: tokenOutputCount(assets.bsv20Balances),
			bsv: assets.funding.length,
		}),
		[
			listings.length,
			unlistedOrdinals.length,
			unlistedOpns.length,
			assets.bsv21Tokens,
			assets.bsv20Balances,
			assets.funding.length,
		],
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

	// Select all unlisted ordinals by default when assets load
	useEffect(() => {
		if (unlistedOrdinals.length > 0 && selectedOrdinals.size === 0) {
			setSelectedOrdinals(
				new Set(unlistedOrdinals.map((item) => item.outpoint)),
			);
		}
	}, [unlistedOrdinals, selectedOrdinals.size]);

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

	return (
		<section className="space-y-6">
			{phase === "preview" && totalAssets > 0 && (
				<div className="flex justify-end">
					<Badge variant="secondary">
						{totalAssets} sweepable asset
						{totalAssets !== 1 ? "s" : ""}
					</Badge>
				</div>
			)}

			<div className="space-y-4">
				{/* Scanning */}
				{phase === "scan" && assets.loading && (
					<ScanningState scanDetail={scanDetail} />
				)}

				{/* Scan error */}
				{phase === "scan" && assets.error && (
					<Card className="border-destructive/50">
						<CardContent className="py-6 space-y-3">
							<p className="text-sm text-destructive">{assets.error}</p>
							<Button variant="outline" onClick={assets.rescan}>
								Retry Scan
							</Button>
						</CardContent>
					</Card>
				)}

				{/* Preview: show categorized assets */}
				{phase === "preview" && (
					<>
						{legacy ? (
							<Card>
								<CardHeader>
									<CardTitle>
										{legacy.sweepOnly
											? "Legacy Assets Found"
											: "Migration Required"}
									</CardTitle>
									<CardDescription>
										{legacy.sweepOnly
											? "Your wallet is already migrated, but assets remain at your legacy addresses. Review them below, then sweep."
											: "Your wallet uses the legacy payment key as its BRC-100 root. Review the assets below, then migrate."}
									</CardDescription>
								</CardHeader>
								<CardContent className="space-y-2 text-sm">
									<div className="flex justify-between">
										<span className="text-muted-foreground">
											Legacy Pay Address
										</span>
										<code className="text-xs">{legacy.payAddress}</code>
									</div>
									<div className="flex justify-between">
										<span className="text-muted-foreground">
											Legacy Ord Address
										</span>
										<code className="text-xs">{legacy.ordAddress}</code>
									</div>
								</CardContent>
							</Card>
						) : (
							<Card>
								<CardHeader>
									<CardTitle>Open listings</CardTitle>
									<CardDescription>
										These listings are being retired. Cancel them to return each
										ordinal to your wallet. Nothing else will be moved.
									</CardDescription>
								</CardHeader>
							</Card>
						)}

						<div className="space-y-3">
							<TypeChecklist
								types={selectedTypes}
								counts={typeCounts}
								onToggle={handleToggleType}
							/>

							<ListingsSection
								reRoot={legacy ? !legacy.sweepOnly : false}
								listings={listings}
							/>

							{selectedTypes.has("bsv") && (
								<FundingSection
									funding={assets.funding}
									totalBsv={assets.totalBsv}
								/>
							)}

							{selectedTypes.has("ordinals") && (
								<>
									<OrdinalsSection
										ordinals={unlistedOrdinals}
										selectedOrdinals={selectedOrdinals}
										onToggle={handleToggleOrdinal}
										onSelectAll={handleSelectAll}
										onDeselectAll={handleDeselectAll}
										ordinalPage={ordinalPage}
										onPageChange={setOrdinalPage}
									/>
									<OpnsSection opnsNames={unlistedOpns} />
								</>
							)}

							{selectedTypes.has("bsv21") && (
								<TokensSection tokens={assets.bsv21Tokens} />
							)}

							<Bsv20Section
								tokens={selectedTypes.has("bsv20") ? assets.bsv20Balances : []}
								unsweepable={assets.bsv20Unsweepable}
							/>

							<LockedSection locked={unlistedLocked} />

							<RunSection run={unlistedRun} />
						</div>

						{totalAssets === 0 &&
							listings.length === 0 &&
							assets.bsv20Tokens.length === 0 && (
								<Card>
									<CardContent className="py-8 text-center text-muted-foreground">
										No assets found at legacy addresses.
										{legacy &&
											!legacy.sweepOnly &&
											" Migration will still derive your identity key."}
									</CardContent>
								</Card>
							)}

						<Separator />

						<div className="space-y-3">
							{listings.length > 0 && (
								<>
									<p className="text-xs text-muted-foreground">
										Cancel listings only returns those ordinals to the wallet.
										It does not sweep BSV, tokens, or other ordinals.
									</p>
									<Button
										variant="outline"
										onClick={() => void runDelistOnly()}
										className="w-full"
									>
										Cancel listings only
										{` (${listings.length})`}
									</Button>
								</>
							)}
							{legacy && (
								<>
									<div className="text-xs text-muted-foreground">
										{legacy.sweepOnly
											? "This will cancel selected listings, then sweep the selected asset types into your wallet."
											: `This will: derive your identity key, re-encrypt your wallet backup, reinitialize the BRC-100 wallet${
													totalAssets > 0
														? ", cancel selected listings, and sweep selected asset types"
														: ""
												}.`}
									</div>
									<Button
										onClick={() => void runMigration()}
										className="w-full"
									>
										{legacy.sweepOnly
											? "Sweep selected assets"
											: "Derive Identity Key & Sweep"}
										{totalAssets > 0 &&
											` (${totalAssets} asset${totalAssets !== 1 ? "s" : ""})`}
									</Button>
								</>
							)}
						</div>
					</>
				)}

				{/* Migrating */}
				{phase === "migrate" && (
					<MigrationProgress
						progress={progress}
						progressPercent={progressPercent}
						sweepProgress={sweepProgress}
					/>
				)}

				{/* Complete */}
				{phase === "complete" && (
					<CompletionState
						sweepResult={sweepResult}
						remaining={assets.scanned && !assets.loading ? sweepableLegacy : 0}
						onBackToWallet={() => router.push("/wallet")}
						onRetryFailed={() => {
							setSweepResult(null);
							setSweepProgress(null);
							setScanDetail(null);
							setPhase("scan");
							assets.rescan();
						}}
					/>
				)}

				{/* Error */}
				{phase === "error" && error && (
					<ErrorState
						error={error}
						onRetry={() => setPhase("preview")}
						onBack={() => router.push("/wallet")}
					/>
				)}
			</div>
		</section>
	);
}
