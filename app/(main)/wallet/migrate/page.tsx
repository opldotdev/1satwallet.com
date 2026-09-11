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
	MneeSection,
	OpnsSection,
	OrdinalsSection,
	RunSection,
	SweepStepsList,
	TokensSection,
	TypeChecklist,
} from "@/components/wallet/migration-sections";
import { useLegacyAssets } from "@/lib/hooks/use-legacy-assets";
import { deriveIdentityKey } from "@/lib/keys";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import type { SweepProgress, SweepResult } from "@/lib/sweep-migration";
import {
	type AssetType,
	defaultAssetTypes,
	delistMigrationListings,
	executeMigrationPlan,
	isListedOutput,
	listedFromLegacy,
	listedFromWallet,
	mergeListed,
	planMigration,
	plannedCount,
	toggleAssetType,
	withoutListed,
} from "@/lib/wallet/migration-listings";
import {
	detectMigrationStatus,
	legacyMigrationKeys,
	type MigrationStatus,
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
							"Looking for BSV, ordinals, tokens and MNEE at your legacy addresses..."}
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
	delistOnly,
	onBackToWallet,
	onRetryFailed,
}: {
	sweepResult: SweepResult | null;
	delistOnly: boolean;
	onBackToWallet: () => void;
	onRetryFailed: () => void;
}) {
	const hadErrors = (sweepResult?.errors.length ?? 0) > 0;
	return (
		<Card>
			<CardHeader>
				<CardTitle>
					{delistOnly
						? "Listings Cancelled"
						: sweepResult
							? hadErrors
								? "Sweep Finished With Errors"
								: "Migration Complete"
							: "Already Migrated"}
				</CardTitle>
				<CardDescription>
					{delistOnly
						? "The listed ordinals have been returned to your wallet."
						: sweepResult
							? hadErrors
								? "Some assets could not be swept. You can rescan and retry the remainder — successfully swept assets are already safe in your wallet."
								: "Your wallet has been migrated to the identity key system."
							: "Your wallet is already using the identity key system and no sweepable assets remain at your legacy addresses."}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{sweepResult && (
					<div className="space-y-2 text-sm">
						{sweepResult.bsvTxids.map((txid) => (
							<div key={txid} className="flex justify-between">
								<span className="text-muted-foreground">BSV Sweep</span>
								<code className="text-xs font-mono">
									{txid.slice(0, 16)}...
								</code>
							</div>
						))}
						{sweepResult.ordinalTxids.map((txid) => (
							<div key={txid} className="flex justify-between">
								<span className="text-muted-foreground">Ordinal Sweep</span>
								<code className="text-xs font-mono">
									{txid.slice(0, 16)}...
								</code>
							</div>
						))}
						{sweepResult.bsv21Txids.map((txid) => (
							<div key={txid} className="flex justify-between">
								<span className="text-muted-foreground">Token Sweep</span>
								<code className="text-xs font-mono">
									{txid.slice(0, 16)}...
								</code>
							</div>
						))}
						{(sweepResult.cancelTxids ?? []).map((txid) => (
							<div key={txid} className="flex justify-between">
								<span className="text-muted-foreground">Listing cancelled</span>
								<code className="text-xs font-mono">
									{txid.slice(0, 16)}...
								</code>
							</div>
						))}
						{sweepResult.mneeTxid && (
							<div className="flex justify-between">
								<span className="text-muted-foreground">MNEE Sweep</span>
								<code className="text-xs font-mono">
									{sweepResult.mneeTxid.slice(0, 16)}...
								</code>
							</div>
						)}
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
						{sweepResult.bsvTxids.length === 0 &&
							sweepResult.ordinalTxids.length === 0 &&
							sweepResult.bsv21Txids.length === 0 &&
							(sweepResult.cancelTxids?.length ?? 0) === 0 &&
							!sweepResult.mneeTxid &&
							sweepResult.errors.length === 0 && (
								<p className="text-sm text-muted-foreground">
									No assets found at legacy addresses.
								</p>
							)}
					</div>
				)}
				{hadErrors && (
					<Button className="w-full" onClick={onRetryFailed}>
						Rescan &amp; Retry Failed Sweeps
					</Button>
				)}
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
	delistOnly,
	onRetry,
	onBack,
}: {
	error: string;
	delistOnly: boolean;
	onRetry: () => void;
	onBack: () => void;
}) {
	return (
		<Card className="border-destructive/50">
			<CardHeader>
				<CardTitle className="text-destructive">
					{delistOnly ? "Listing Cancellation Incomplete" : "Migration Error"}
				</CardTitle>
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
	const [delistOnly, setDelistOnly] = useState(false);
	const [completedListings, setCompletedListings] = useState<Set<string>>(
		new Set(),
	);

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
	const legacy = useMemo(
		() => legacyMigrationKeys(migrationStatus),
		[migrationStatus],
	);

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
					...assets.listings,
					...assets.ordinals,
					...assets.opnsNames,
					...assets.locked,
					...assets.run,
				]),
			).filter((item) => !completedListings.has(item.outpoint)),
		[
			completedListings,
			toolbox.ordinals,
			assets.listings,
			assets.ordinals,
			assets.opnsNames,
			assets.locked,
			assets.run,
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
		() =>
			[
				...assets.listings,
				...assets.ordinals,
				...assets.opnsNames,
				...assets.locked,
				...assets.run,
			].filter(
				(item) => isListedOutput(item) && !completedListings.has(item.outpoint),
			),
		[
			assets.listings,
			assets.ordinals,
			assets.opnsNames,
			assets.locked,
			assets.run,
			completedListings,
		],
	);

	const typeCounts = useMemo(
		() => ({
			listings: listings.length,
			ordinals: unlistedOrdinals.length + unlistedOpns.length,
			bsv21:
				assets.bsv21Tokens.reduce(
					(sum, token) => sum + token.outputs.length,
					0,
				) + (assets.mneeBalance > 0 ? 1 : 0),
			bsv: assets.funding.length,
		}),
		[
			listings.length,
			unlistedOrdinals.length,
			unlistedOpns.length,
			assets.bsv21Tokens,
			assets.mneeBalance,
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
				mneeBalance: assets.mneeBalance,
			}),
		[
			selectedTypes,
			listings,
			listedLegacyOutputs,
			selectedUnlisted,
			unlistedOpns,
			assets.funding,
			assets.bsv21Tokens,
			assets.mneeBalance,
		],
	);

	// Sweepable asset counts (opns names sweep together with ordinals)
	const totalAssets = plannedCount(plan);

	// Transition from scan to preview when scan completes
	useEffect(() => {
		if (!migrationStatus) return;

		if (phase !== "scan") return;

		if (assets.loading || assets.error || toolbox.isBalanceLoading) return;

		if (!legacy) {
			if (migrationStatus.status === "migrated") {
				setPhase(listings.length > 0 ? "preview" : "complete");
			} else {
				setError("Wallet cannot be migrated (missing pay or ord key)");
				setPhase("error");
			}
			return;
		}

		if (
			legacy.sweepOnly &&
			assets.funding.length +
				assets.ordinals.length +
				assets.opnsNames.length +
				assets.bsv21Tokens.reduce(
					(sum, token) => sum + token.outputs.length,
					0,
				) ===
				0 &&
			assets.mneeBalance <= 0 &&
			listings.length === 0
		) {
			// Already migrated and legacy addresses are empty
			setPhase("complete");
		} else {
			setPhase("preview");
		}
	}, [
		migrationStatus,
		legacy,
		phase,
		assets.loading,
		assets.error,
		assets.mneeBalance,
		assets.funding.length,
		assets.ordinals.length,
		assets.opnsNames.length,
		assets.bsv21Tokens,
		listings.length,
		toolbox.isBalanceLoading,
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

	const runDelistOnly = useCallback(async () => {
		setDelistOnly(true);
		if (!toolbox.oneSatContext) {
			setError("Unlock your wallet to cancel listings.");
			setPhase("error");
			return;
		}
		setPhase("migrate");
		setError(null);
		setSweepResult(null);
		setProgress("Cancelling listings...");
		setProgressPercent(20);
		setSweepProgress(null);
		try {
			const result = await delistMigrationListings({
				ctx: toolbox.oneSatContext,
				listings,
				legacyOutputs: listedLegacyOutputs,
				sweepParams:
					legacy && toolbox.wallet && toolbox.services
						? {
								wallet: toolbox.wallet,
								services: toolbox.services,
								chain: toolbox.chain,
								legacyPayWif: legacy.payWif,
								legacyOrdWif: legacy.ordWif,
								legacyIdentityWif: legacy.identityWif,
								onProgress: (p) => {
									setProgress(p.message);
									setSweepProgress(p);
								},
							}
						: null,
			});
			setSweepResult(result);
			setCompletedListings(
				(previous) => new Set([...previous, ...result.completedOutpoints]),
			);
			assets.rescan();
			toolbox.refreshBalance();
			if (result.errors.length > 0) {
				setError(
					`${result.completedOutpoints.length} listing(s) cancelled. ${result.errors.join(" ")}`,
				);
				setPhase("error");
				return;
			}
			setProgressPercent(100);
			setPhase("complete");
		} catch (err) {
			reportDiagnostic({
				category: "action",
				code: "action.failed",
				operation: "wallet.migration.delist",
				recoverable: true,
			});
			setError(err instanceof Error ? err.message : String(err));
			setPhase("error");
		}
	}, [assets.rescan, legacy, listings, listedLegacyOutputs, toolbox]);

	// Run migration (or sweep-only re-entry for already-migrated wallets)
	const runMigration = useCallback(async () => {
		if (!walletKeys || !legacy) return;

		setPhase("migrate");
		setError(null);
		setDelistOnly(false);
		setProgressPercent(0);
		setSweepProgress(null);

		try {
			let identityWif = legacy.identityWif;

			if (!legacy.sweepOnly) {
				// 1. Derive identity key
				setProgress("Deriving identity key...");
				setProgressPercent(10);
				const identityKey = deriveIdentityKey(legacy.payWif, legacy.ordWif);
				identityWif = identityKey.toWif();

				// 2. Update keys with identity
				const updatedKeys = {
					...walletKeys,
					identityPk: identityWif,
					identityAddressPath: "derived" as string | number | undefined,
				};

				// 3. Re-encrypt wallet
				setProgress("Updating encrypted wallet...");
				setProgressPercent(25);
				const reencrypted = await reencryptWallet(updatedKeys);
				if (!reencrypted) {
					throw new Error(
						"Failed to re-encrypt wallet. Try unlocking your wallet again first.",
					);
				}

				// 4. Reinitialize BRC-100 wallet with identity key
				setProgress("Reinitializing BRC-100 wallet...");
				setProgressPercent(40);
				if (toolbox.isInitialized) {
					await toolbox.destroyWallet();
				}

				await new Promise((r) => setTimeout(r, 500));

				const { wifToHex } = await import("@1sat/utils");
				const rootKeyHex = wifToHex(identityWif);
				const initialized = await toolbox.initializeWallet(rootKeyHex);

				if (!initialized) {
					throw new Error("Failed to initialize wallet with identity key");
				}
			}

			if (!toolbox.wallet || !toolbox.services || !toolbox.oneSatContext) {
				throw new Error(
					"BRC-100 wallet is not initialized — unlock your wallet and try again",
				);
			}
			const base = legacy.sweepOnly ? 0 : 60;
			const result = await executeMigrationPlan({
				ctx: toolbox.oneSatContext,
				plan,
				listings,
				legacyOutputs: listedLegacyOutputs,
				sweepParams: {
					wallet: toolbox.wallet,
					services: toolbox.services,
					chain: toolbox.chain,
					legacyPayWif: legacy.payWif,
					legacyOrdWif: legacy.ordWif,
					legacyIdentityWif: identityWif,
					onProgress: (p) => {
						setProgress(p.message);
						setProgressPercent(
							base + Math.round((p.percent / 100) * (100 - base)),
						);
						setSweepProgress(p);
					},
				},
				mneeBalance: assets.mneeBalance,
			});
			setSweepResult(result);
			setCompletedListings(
				(previous) => new Set([...previous, ...result.completedOutpoints]),
			);
			assets.rescan();
			toolbox.refreshBalance();

			setProgressPercent(100);
			setPhase("complete");
		} catch (err) {
			reportDiagnostic({
				category: "action",
				code: "action.failed",
				operation: "wallet.migration.run",
				recoverable: true,
			});
			setError(err instanceof Error ? err.message : String(err));
			setPhase("error");
		}
	}, [
		walletKeys,
		legacy,
		toolbox,
		assets.mneeBalance,
		assets.rescan,
		plan,
		listings,
		listedLegacyOutputs,
	]);

	if (toolbox.connectionMode === "external") {
		return (
			<section className="space-y-6">
				<div className="flex items-center justify-between gap-3">
					<h2 className="font-mono text-xl font-medium">Wallet Migration</h2>
				</div>
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
				<div className="flex items-center justify-between gap-3">
					<h2 className="font-mono text-xl font-medium">Wallet Migration</h2>
				</div>
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
			<div className="flex items-center justify-between gap-3">
				<h2 className="font-mono text-xl font-medium">Wallet Migration</h2>
				{phase === "preview" && totalAssets > 0 && (
					<Badge variant="secondary">
						{totalAssets} sweepable asset
						{totalAssets !== 1 ? "s" : ""}
					</Badge>
				)}
			</div>

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

							<ListingsSection listings={listings} />

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
								<>
									<TokensSection tokens={assets.bsv21Tokens} />
									<MneeSection mneeBalance={assets.mneeBalance} />
								</>
							)}

							<Bsv20Section tokens={assets.bsv20Tokens} />

							<LockedSection locked={unlistedLocked} />

							<RunSection run={unlistedRun} />
						</div>

						{totalAssets === 0 &&
							listings.length === 0 &&
							assets.bsv20Tokens.length === 0 &&
							assets.mneeBalance <= 0 && (
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
						delistOnly={delistOnly}
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
						delistOnly={delistOnly}
						onRetry={() => setPhase("preview")}
						onBack={() => router.push("/wallet")}
					/>
				)}
			</div>
		</section>
	);
}
