"use client";

import { ArrowRight, Download, Shield } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { MigrationSweepFlow } from "@/components/wallet/migration-sections";
import { buildInfo } from "@/lib/build-info";
import { WALLET_STORAGE_KEY } from "@/lib/constants";
import { useBsv20ContentLabels } from "@/lib/hooks/use-bsv20-content";
import { useDefaultOrdinalSelection } from "@/lib/hooks/use-default-ordinal-selection";
import { useLegacyAssets } from "@/lib/hooks/use-legacy-assets";
import { deriveIdentityKey } from "@/lib/keys";
import { type AuditPlan, auditPlanFromScan } from "@/lib/sweep-audit/plan";
import {
	migrationAuditSources,
	sweepAuditIdentityKey,
	useSweepAudit,
} from "@/lib/sweep-audit/use-sweep-audit";
import {
	emptySweepResult,
	executeMigrationSweep,
	type SweepProgress,
	type SweepResult,
} from "@/lib/sweep-migration";
import {
	cancelWalletListings,
	partialRunResult,
	runFirstRunMigration,
} from "@/lib/wallet/first-run-migration";
import { countSweepableLegacyAssets } from "@/lib/wallet/legacy-scan-state";
import {
	type AssetType,
	defaultAssetTypes,
	listedFromLegacy,
	listedFromWallet,
	mergeListed,
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
	migrationDeferredKey,
	reportMigrationFailure,
} from "@/lib/wallet-migration";
import { reencryptWallet } from "@/lib/wallet-storage";
import { useWallet } from "@/providers/wallet-provider";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

type WizardStep =
	| "intro"
	| "scan"
	| "preview"
	| "migrate"
	| "complete"
	| "error";

function downloadBackup() {
	if (typeof window === "undefined") return;
	const raw = localStorage.getItem(WALLET_STORAGE_KEY);
	if (!raw) return;
	const blob = new Blob([raw], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = `1sat-wallet-backup-${Date.now()}.json`;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

export function MigrationWizard() {
	const router = useRouter();
	const { walletKeys, isWalletLocked, isWalletInitialized, hasWallet } =
		useWallet();
	const toolbox = useWalletToolbox();

	const [step, setStep] = useState<WizardStep>("intro");
	const [progress, setProgress] = useState("");
	const [progressPercent, setProgressPercent] = useState(0);
	const [sweepProgress, setSweepProgress] = useState<SweepProgress | null>(
		null,
	);
	const [scanDetail, setScanDetail] = useState<string | null>(null);
	const [sweepResult, setSweepResult] = useState<SweepResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	const [selectedTypes, setSelectedTypes] = useState<Set<AssetType>>(() =>
		defaultAssetTypes(),
	);
	const audit = useSweepAudit();
	const auditIdentity = useMemo(
		() => (walletKeys ? sweepAuditIdentityKey(walletKeys) : null),
		[walletKeys],
	);
	const [deferredReady, setDeferredReady] = useState(false);
	const [deferred, setDeferred] = useState(false);

	useEffect(() => {
		setDeferred(
			walletKeys
				? window.localStorage.getItem(migrationDeferredKey(walletKeys)) === "1"
				: false,
		);
		setDeferredReady(true);
	}, [walletKeys]);

	const deferMigration = useCallback(() => {
		if (!walletKeys) return;
		window.localStorage.setItem(migrationDeferredKey(walletKeys), "1");
		setDeferred(true);
	}, [walletKeys]);

	// Detect migration status
	const migrationStatus: MigrationStatus | null = useMemo(() => {
		if (!walletKeys || isWalletLocked) return null;
		return detectMigrationStatus(walletKeys);
	}, [walletKeys, isWalletLocked]);

	const needsMigration = migrationStatus?.status === "legacy";

	// Legacy addresses for scanning
	const legacyPayAddress =
		migrationStatus?.status === "legacy"
			? migrationStatus.legacyPayAddress
			: null;
	const legacyOrdAddress =
		migrationStatus?.status === "legacy"
			? migrationStatus.legacyOrdAddress
			: null;

	// Only scan when we've moved past intro
	const shouldScan =
		toolbox.connectionMode !== "external" && step !== "intro" && needsMigration;
	const assets = useLegacyAssets(
		shouldScan ? legacyPayAddress : null,
		shouldScan ? legacyOrdAddress : null,
		null,
		(p) => setScanDetail(p.detail ?? p.phase),
	);

	// Transition from scan to preview when scan completes
	useEffect(() => {
		if (step !== "scan") return;
		if (!assets.loading && !assets.error) {
			setStep("preview");
		}
	}, [step, assets.loading, assets.error]);

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
	// Every unlisted ordinal starts selected, once per set of outpoints.
	const [selectedOrdinals, setSelectedOrdinals] =
		useDefaultOrdinalSelection(unlistedOrdinals);
	const unlistedOpns = useMemo(
		() => withoutListed(assets.opnsNames),
		[assets.opnsNames],
	);
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

	// Ordinal selection handlers
	const handleToggleOrdinal = useCallback(
		(outpoint: string) => {
			setSelectedOrdinals((prev) => {
				const next = new Set(prev);
				if (next.has(outpoint)) {
					next.delete(outpoint);
				} else {
					next.add(outpoint);
				}
				return next;
			});
		},
		[setSelectedOrdinals],
	);

	const handleSelectAll = useCallback(() => {
		setSelectedOrdinals(new Set(unlistedOrdinals.map((item) => item.outpoint)));
	}, [unlistedOrdinals, setSelectedOrdinals]);

	const handleDeselectAll = useCallback(() => {
		setSelectedOrdinals(new Set());
	}, [setSelectedOrdinals]);

	const handleToggleType = useCallback((type: AssetType) => {
		setSelectedTypes((prev) => toggleAssetType(prev, type));
	}, []);

	// Ordinals to sweep: selected unlisted, OpNS, and listed leftovers
	const sweepOrdinals = useMemo(() => {
		return [...plan.sweepOrdinals, ...plan.sweepListed];
	}, [plan.sweepOrdinals, plan.sweepListed]);

	const tokenOutputs = useMemo(
		() => tokenOutputCount(plan.sweepBsv21) + tokenOutputCount(plan.sweepBsv20),
		[plan.sweepBsv21, plan.sweepBsv20],
	);

	// Starts this run's support record: what the scan found, what this run
	// sends, and every output it leaves out. Addresses only, never keys.
	const beginAudit = useCallback(
		(runPlan: AuditPlan, skippedReason?: string) =>
			audit.begin(
				{
					kind: "migration",
					chain: toolbox.chain,
					app: buildInfo(),
					sources: migrationAuditSources({
						payAddress: legacyPayAddress,
						ordAddress: legacyOrdAddress,
					}),
					destination: "This wallet, upgraded to its identity key",
					...auditPlanFromScan(assets, runPlan, { listings, skippedReason }),
				},
				auditIdentity,
			),
		[
			audit.begin,
			toolbox.chain,
			legacyPayAddress,
			legacyOrdAddress,
			assets,
			listings,
			auditIdentity,
		],
	);

	// Run migration
	const runMigration = useCallback(async () => {
		if (!walletKeys || !migrationStatus || migrationStatus.status !== "legacy")
			return;

		setStep("migrate");
		setError(null);
		setProgressPercent(0);
		const trail = beginAudit(plan);

		try {
			setProgress("Deriving identity key...");
			setProgressPercent(10);
			const identityKey = deriveIdentityKey(
				migrationStatus.legacyPayWif,
				migrationStatus.legacyOrdWif,
			);
			const identityWif = identityKey.toWif();

			const updatedKeys = {
				...walletKeys,
				identityPk: identityWif,
				identityAddressPath: "derived" as string | number | undefined,
			};

			// `toolbox` is this render's snapshot: after the re-root it still
			// points at the destroyed pay-key wallet, so the sweep uses the
			// wallet runFirstRunMigration hands back.
			const run = await runFirstRunMigration({
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
				onStage: (stage) => {
					trail.stage(stage);
					if (stage === "cancel") {
						setProgress("Cancelling listings...");
						setProgressPercent(15);
					} else if (stage === "transfer") {
						setProgress("Moving this wallet's assets to your identity key...");
						setProgressPercent(20);
					} else if (stage === "persist") {
						setProgress("Updating encrypted wallet...");
						setProgressPercent(25);
					} else if (stage === "reroot") {
						setProgress("Reinitializing BRC-100 wallet...");
						setProgressPercent(40);
					}
				},
				sweep: async (target) => {
					const totalSweepable =
						plan.sweepFunding.length + sweepOrdinals.length + tokenOutputs;
					if (totalSweepable === 0) return null;
					setProgress(
						`Sweeping ${totalSweepable} asset${totalSweepable !== 1 ? "s" : ""}...`,
					);
					// Pre-sweep stages span 0-60%; the sweep's unit-based percent
					// fills the remaining 40%
					setProgressPercent(60);
					return executeMigrationSweep({
						wallet: target.wallet,
						services: target.services,
						chain: toolbox.chain,
						legacyPayWif: migrationStatus.legacyPayWif,
						legacyOrdWif: migrationStatus.legacyOrdWif,
						legacyIdentityWif: identityWif,
						onProgress: (p) => {
							trail.progress(p);
							setProgress(p.message);
							setProgressPercent(60 + Math.round((p.percent / 100) * 40));
							setSweepProgress(p);
						},
						funding: plan.sweepFunding,
						ordinals: sweepOrdinals,
						bsv21Tokens: plan.sweepBsv21,
						bsv20Tokens: plan.sweepBsv20,
					});
				},
			});

			if (run.sweep && run.sweep.errors.length > 0) {
				console.error(
					"[migration] sweep finished with errors",
					run.sweep.errors,
				);
			}
			const finalResult: SweepResult = {
				...(run.sweep ?? emptySweepResult()),
				cancelTxids: run.cancelTxids,
				transferTxids: run.transferTxids,
			};
			trail.finish(finalResult);
			setSweepResult(finalResult);
			if (run.sweep || run.transferTxids.length > 0) {
				assets.rescan();
				toolbox.refreshBalance();
			}

			window.localStorage.removeItem(migrationDeferredKey(walletKeys));
			setProgressPercent(100);
			setStep("complete");
		} catch (err) {
			reportMigrationFailure("wallet.migration.run", err);
			const partial = partialRunResult(err);
			trail.fail(err, partial);
			if (partial) setSweepResult(emptySweepResult(partial));
			setError(err instanceof Error ? err.message : String(err));
			setStep("error");
		}
	}, [
		walletKeys,
		migrationStatus,
		toolbox,
		assets.rescan,
		sweepOrdinals,
		tokenOutputs,
		plan.cancel,
		plan.sweepFunding,
		plan.sweepBsv21,
		plan.sweepBsv20,
		plan,
		beginAudit,
	]);

	const runDelistOnly = useCallback(async () => {
		if (!toolbox.oneSatContext) {
			setError("Unlock your wallet to cancel listings.");
			setStep("error");
			return;
		}
		setStep("migrate");
		setError(null);
		setProgress("Cancelling listings...");
		setProgressPercent(20);
		const walletListings = listings.filter((item) => item.source === "wallet");
		const trail = beginAudit(
			{
				cancel: walletListings,
				sweepListed: [],
				sweepOrdinals: [],
				sweepFunding: [],
				sweepBsv21: [],
				sweepBsv20: [],
			},
			"not part of this run (cancel listings only)",
		);
		try {
			trail.stage("cancel");
			const cancelTxids = await cancelWalletListings(
				toolbox.oneSatContext,
				walletListings,
			);
			const result = emptySweepResult({ cancelTxids });
			trail.finish(result);
			setSweepResult(result);
			assets.rescan();
			toolbox.refreshBalance();
			setProgressPercent(100);
			setStep("complete");
		} catch (err) {
			reportMigrationFailure("wallet.migration.delist", err);
			const partial = partialRunResult(err);
			trail.fail(err, partial);
			if (partial) setSweepResult(emptySweepResult(partial));
			setError(err instanceof Error ? err.message : String(err));
			setStep("error");
		}
	}, [assets.rescan, listings, toolbox, beginAudit]);

	const totalAssets = plannedCount(plan);

	const unlistedLocked = useMemo(
		() => withoutListed(assets.locked),
		[assets.locked],
	);
	const unlistedRun = useMemo(() => withoutListed(assets.run), [assets.run]);
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

	// Don't render if not applicable
	if (toolbox.connectionMode === "external") return null;
	if (!isWalletInitialized) return null;
	if (!hasWallet) return null;
	if (isWalletLocked) return null;
	if (!needsMigration) return null;
	if (!deferredReady || deferred) return null;
	// Once complete or dismissed, don't show
	if (step === "complete" && !sweepResult) return null;

	const hadErrors = (sweepResult?.errors.length ?? 0) > 0;
	const retryFailed = () => {
		audit.clear();
		setSweepResult(null);
		setSweepProgress(null);
		setScanDetail(null);
		setStep("scan");
		assets.rescan();
	};
	const goToWallet = () => {
		// The wizard unmounts once migrationStatus reads "migrated".
		router.push("/wallet");
		router.refresh();
	};

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Wallet migration"
			className="fixed inset-0 z-[120] flex items-stretch justify-center bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] backdrop-blur-md sm:items-center sm:p-6"
		>
			{/* Ambient glow */}
			<div className="pointer-events-none absolute inset-0 overflow-hidden">
				<div className="absolute -top-1/4 left-1/2 h-[600px] w-[600px] -translate-x-1/2 rounded-full bg-primary/5 blur-[120px]" />
			</div>

			{/* Full screen on phones; a card from sm. The footer sticks to the
			    bottom of this scroll container. */}
			<div className="relative z-10 flex w-full max-w-lg flex-col overflow-y-auto overscroll-contain px-4 pt-4 motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-300 sm:max-h-[min(90dvh,100%)] sm:rounded-xl sm:border sm:bg-card sm:px-6 sm:pt-6 sm:shadow-lg">
				{step === "intro" ? (
					<div className="my-auto py-8">
						<IntroStep
							onMigrateNow={() => setStep("scan")}
							onMigrateLater={deferMigration}
							onStartFresh={() => {
								downloadBackup();
								router.push("/wallet/create");
							}}
						/>
					</div>
				) : (
					<MigrationSweepFlow
						variant="dialog"
						screen={sweepScreenFor(
							step === "error" && !error ? "preview" : step,
						)}
						firstRun
						canSweep={migrationStatus?.status === "legacy"}
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
						onLater={deferMigration}
						progressMessage={progress}
						progressPercent={progressPercent}
						sweepProgress={sweepProgress}
						sweepResult={sweepResult}
						remaining={
							assets.scanned && !assets.loading
								? countSweepableLegacyAssets(assets)
								: 0
						}
						doneLabel={() =>
							hadErrors ? "Rescan & Retry Failed Sweeps" : "Go to wallet"
						}
						onDone={hadErrors ? retryFailed : goToWallet}
						doneSecondary={
							hadErrors
								? { label: "Go to wallet", onClick: goToWallet }
								: undefined
						}
						error={error}
						onTryAgain={() => setStep("preview")}
						addresses={
							migrationStatus?.status === "legacy"
								? [
										{
											label: "Old pay address",
											address: migrationStatus.legacyPayAddress,
										},
										{
											label: "Old ordinals address",
											address: migrationStatus.legacyOrdAddress,
										},
									]
								: []
						}
						destination="This wallet, upgraded to your identity key"
						bsv20={bsv20Display}
						onStepChange={setWizardStep}
						auditRecord={audit.record}
						auditSaveError={audit.saveError}
					/>
				)}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Step: Intro
// ---------------------------------------------------------------------------

function IntroStep({
	onMigrateNow,
	onMigrateLater,
	onStartFresh,
}: {
	onMigrateNow: () => void;
	onMigrateLater: () => void;
	onStartFresh: () => void;
}) {
	return (
		<div className="space-y-8 text-center">
			<div className="space-y-4">
				<div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/20">
					<Shield className="h-8 w-8 text-primary" />
				</div>
				<h2 className="text-3xl font-bold tracking-tight">
					Migrate your assets
				</h2>
				<p className="mx-auto max-w-md text-muted-foreground leading-relaxed">
					This is not a key from a modern wallet. You may need to migrate your
					assets to see them. You can do this now, or later from the wallet.
				</p>
			</div>

			<div className="mx-auto max-w-sm space-y-3">
				<Button
					onClick={onMigrateNow}
					className="w-full h-12 text-base gap-2"
					size="lg"
				>
					Migrate Now
					<ArrowRight className="h-4 w-4" data-icon="inline-end" />
				</Button>
				<Button
					variant="outline"
					onClick={onMigrateLater}
					className="w-full h-12 text-base"
					size="lg"
				>
					Migrate Later
				</Button>

				<div className="relative">
					<div className="absolute inset-0 flex items-center">
						<div className="w-full border-t border-border/50" />
					</div>
					<div className="relative flex justify-center text-xs">
						<span className="bg-background px-3 text-muted-foreground/60">
							or
						</span>
					</div>
				</div>

				<Button
					variant="ghost"
					onClick={onStartFresh}
					className="w-full gap-2 text-muted-foreground hover:text-foreground"
				>
					<Download className="h-4 w-4" data-icon="inline-start" />
					Download Backup &amp; Start Fresh
				</Button>
				<p className="text-[11px] text-muted-foreground/50">
					Downloads your encrypted wallet file, then creates a new wallet.
				</p>
			</div>
		</div>
	);
}
