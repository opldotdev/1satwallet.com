"use client";

import {
	ArrowRight,
	CheckCircle2,
	Circle,
	FileUp,
	Info,
	Loader2,
	XCircle,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { useAddressAssets } from "@/lib/hooks/use-legacy-assets";
import {
	executeKeySweep,
	type SweepProgress,
	type SweepResult,
	type SweepStepState,
} from "@/lib/sweep-migration";
import { actionExplorerUrl } from "@/lib/wallet/action-history";
import type { AddressScanStatus } from "@/lib/wallet/address-scan";
import { requireMigrationTarget } from "@/lib/wallet/first-run-migration";
import { countSweepableLegacyAssets } from "@/lib/wallet/legacy-scan-state";
import {
	defaultAssetTypes,
	isListedOutput,
	listedFromLegacy,
	planMigration,
	tokenOutputCount,
	withoutListed,
} from "@/lib/wallet/migration-listings";
import {
	readSweepFile,
	readSweepText,
	type ScanKey,
	type SweepInput,
	unlockSweepBackup,
} from "@/lib/wallet/sweep-keys";
import {
	backupRestoreErrorMessage,
	classifyBackupRestoreError,
	type DetectedWalletBackup,
} from "@/lib/wallet-backup";
import { reportMigrationFailure } from "@/lib/wallet-migration";
import { useWallet } from "@/providers/wallet-provider";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

type Phase = "input" | "review" | "sweeping" | "done";

/** One finished sweep run: what it moved and how each step ended. */
interface SweepRun {
	result: SweepResult;
	steps: SweepStepState[];
	opnsNames: string[];
}

const SATS_PER_BSV = 100_000_000;

function formatBsv(sats: number): string {
	return `${(sats / SATS_PER_BSV).toLocaleString(undefined, {
		maximumFractionDigits: 8,
	})} BSV`;
}

function formatAmount(raw: bigint, decimals: number): string {
	const text = raw.toString();
	if (decimals === 0) return BigInt(text).toLocaleString();
	const padded = text.padStart(decimals + 1, "0");
	const whole = BigInt(padded.slice(0, -decimals)).toLocaleString();
	const fraction = padded.slice(-decimals).replace(/0+$/, "");
	return fraction ? `${whole}.${fraction}` : whole;
}

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n} ${n === 1 ? one : many}`;

function StatusIcon({ status }: { status: SweepStepState["status"] }) {
	if (status === "done") {
		return <CheckCircle2 className="h-4 w-4 shrink-0 text-chart-2" />;
	}
	if (status === "error") {
		return <XCircle className="h-4 w-4 shrink-0 text-destructive" />;
	}
	if (status === "active") {
		return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />;
	}
	return <Circle className="h-4 w-4 shrink-0 text-muted-foreground/40" />;
}

function InfoToggle({
	open,
	onToggle,
	label,
}: {
	open: boolean;
	onToggle: () => void;
	label: string;
}) {
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-expanded={open}
			aria-label={label}
			title={label}
			className="inline-flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground"
		>
			<Info className="h-4 w-4" />
		</button>
	);
}

/** One readable line per asset: what it is and how much. */
function AssetRow({
	name,
	amount,
	note,
}: {
	name: string;
	amount: string;
	note?: string;
}) {
	return (
		<div className="flex items-baseline justify-between gap-3 py-2">
			<div className="min-w-0">
				<div className="truncate text-sm font-medium">{name}</div>
				{note && <div className="text-xs text-muted-foreground">{note}</div>}
			</div>
			<div className="shrink-0 text-sm tabular-nums">{amount}</div>
		</div>
	);
}

function AddressDetails({
	keys,
	status,
}: {
	keys: ScanKey[];
	status: AddressScanStatus[];
}) {
	const byAddress = new Map(status.map((s) => [s.address, s]));
	return (
		<ul className="space-y-2 border-t border-border/40 pt-3 text-xs">
			{keys.map((key) => {
				const s = byAddress.get(key.address);
				return (
					<li key={key.address} className="flex items-start gap-2">
						<StatusIcon
							status={
								s?.state === "done"
									? "done"
									: s?.state === "error"
										? "error"
										: s?.state === "scanning"
											? "active"
											: "pending"
							}
						/>
						<div className="min-w-0 flex-1">
							<div className="font-medium">{key.label}</div>
							<code className="block break-all font-mono text-[10px] text-muted-foreground">
								{key.address}
							</code>
							{s?.error && <div className="text-destructive">{s.error}</div>}
						</div>
						<span className="shrink-0 text-muted-foreground">
							{s?.state === "done" ? `${s.found ?? 0} found` : ""}
						</span>
					</li>
				);
			})}
		</ul>
	);
}

function TxDetails({
	runs,
	chain,
}: {
	runs: SweepRun[];
	chain: "main" | "test";
}) {
	const rows = runs.flatMap((run, index) =>
		run.steps.flatMap((step) =>
			step.txids.map((txid) => ({
				key: `${index}:${step.id}:${txid}`,
				label: runs.length > 1 ? `Run ${index + 1}: ${step.label}` : step.label,
				txid,
			})),
		),
	);
	if (rows.length === 0) {
		return (
			<p className="border-t border-border/40 pt-3 text-xs text-muted-foreground">
				No transactions were sent.
			</p>
		);
	}
	return (
		<ul className="space-y-2 border-t border-border/40 pt-3 text-xs">
			{rows.map((row) => {
				const href = actionExplorerUrl(row.txid, chain);
				return (
					<li key={row.key}>
						<div className="text-muted-foreground">{row.label}</div>
						{href ? (
							<a
								href={href}
								target="_blank"
								rel="noopener noreferrer"
								className="break-all font-mono text-[10px] underline decoration-dotted underline-offset-2 hover:text-foreground"
							>
								{row.txid}
							</a>
						) : (
							<code className="break-all font-mono text-[10px]">
								{row.txid}
							</code>
						)}
					</li>
				);
			})}
		</ul>
	);
}

/**
 * Sweep a key that is not this wallet's own (a WIF, a key backup, or a
 * recovery phrase at the RelayX path) into this wallet. The key is held in
 * this page's memory only and is never saved.
 */
export function KeySweepTool() {
	const { walletKeys, isWalletLocked } = useWallet();
	const toolbox = useWalletToolbox();
	const fileRef = useRef<HTMLInputElement>(null);

	const [phase, setPhase] = useState<Phase>("input");
	const [text, setText] = useState("");
	const [reading, setReading] = useState(false);
	const [inputError, setInputError] = useState<string | null>(null);
	const [locked, setLocked] = useState<{
		source: string;
		backup: DetectedWalletBackup;
	} | null>(null);
	const [password, setPassword] = useState("");
	const [keys, setKeys] = useState<ScanKey[] | null>(null);
	const [source, setSource] = useState("");
	const [showAddresses, setShowAddresses] = useState(false);
	const [showTxids, setShowTxids] = useState(false);
	const [progress, setProgress] = useState<SweepProgress | null>(null);
	const [sweepError, setSweepError] = useState<string | null>(null);
	const [runs, setRuns] = useState<SweepRun[]>([]);

	const addresses = useMemo(() => keys?.map((k) => k.address) ?? [], [keys]);
	const assets = useAddressAssets(addresses);

	const listings = useMemo(
		() =>
			listedFromLegacy([
				...assets.ordinals,
				...assets.opnsNames,
				...assets.locked,
				...assets.run,
				...assets.listings,
			]),
		[
			assets.ordinals,
			assets.opnsNames,
			assets.locked,
			assets.run,
			assets.listings,
		],
	);
	const unlistedOpns = useMemo(
		() => withoutListed(assets.opnsNames),
		[assets.opnsNames],
	);
	const plan = useMemo(
		() =>
			planMigration({
				types: defaultAssetTypes(),
				listings,
				listedLegacyOutputs: [...assets.ordinals, ...assets.opnsNames].filter(
					isListedOutput,
				),
				ordinals: withoutListed(assets.ordinals),
				opns: unlistedOpns,
				funding: assets.funding,
				bsv21: assets.bsv21Tokens,
				bsv20: assets.bsv20Balances,
			}),
		[
			listings,
			assets.ordinals,
			assets.opnsNames,
			unlistedOpns,
			assets.funding,
			assets.bsv21Tokens,
			assets.bsv20Balances,
		],
	);
	const sweepOrdinals = useMemo(
		() => [...plan.sweepOrdinals, ...plan.sweepListed],
		[plan.sweepOrdinals, plan.sweepListed],
	);
	const inactiveTokens = plan.sweepBsv21.filter((t) => !t.isActive);
	// Inactive tokens are shown but not counted: the sweep skips them.
	const sweepCount =
		plan.sweepFunding.length +
		sweepOrdinals.length +
		tokenOutputCount(plan.sweepBsv21.filter((t) => t.isActive)) +
		tokenOutputCount(plan.sweepBsv20);
	const plainOrdinals = sweepOrdinals.length - unlistedOpns.length;
	const listedCount = sweepOrdinals.filter(isListedOutput).length;
	const notSwept = assets.locked.length + assets.run.length;
	// Only a finished, error-free scan of the current keys may be swept: after
	// a failed scan or a key change the hook still holds the previous result.
	const scanReady = assets.scanned && !assets.loading && !assets.error;
	const remaining =
		assets.scanned && !assets.loading ? countSweepableLegacyAssets(assets) : 0;

	const acceptInput = (input: SweepInput) => {
		if (input.kind === "needs-password") {
			setLocked({ source: input.source, backup: input.backup });
			return;
		}
		setLocked(null);
		setKeys(input.keys);
		setSource(input.source);
		setText("");
		setPhase("review");
	};

	const readInput = async (read: () => Promise<SweepInput>) => {
		setReading(true);
		setInputError(null);
		try {
			acceptInput(await read());
		} catch (error) {
			// The key text is never logged: only why it could not be read.
			console.error("[sweep] key input could not be read", error);
			setInputError(
				error instanceof Error ? error.message : "That key could not be read",
			);
		} finally {
			setReading(false);
		}
	};

	const unlock = async () => {
		if (!locked) return;
		setReading(true);
		setInputError(null);
		try {
			const unlockedKeys = await unlockSweepBackup(locked.backup, password);
			setPassword("");
			acceptInput({ kind: "keys", source: locked.source, keys: unlockedKeys });
		} catch (error) {
			console.error("[sweep] backup could not be unlocked", error);
			setInputError(
				backupRestoreErrorMessage(classifyBackupRestoreError(error), true),
			);
		} finally {
			setReading(false);
		}
	};

	const reset = () => {
		setKeys(null);
		setSource("");
		setLocked(null);
		setPassword("");
		setText("");
		setInputError(null);
		setSweepError(null);
		setProgress(null);
		setShowAddresses(false);
		setPhase("input");
	};

	const runSweep = async () => {
		if (!keys || !scanReady || sweepCount === 0) return;
		setPhase("sweeping");
		setSweepError(null);
		setProgress(null);
		const opnsNames = unlistedOpns.map((o) => o.name ?? o.outpoint);
		try {
			const target = requireMigrationTarget(toolbox);
			const seen: { last: SweepProgress | null } = { last: null };
			const result = await executeKeySweep({
				wallet: target.wallet,
				services: target.services,
				chain: toolbox.chain,
				keys: keys.map(({ label, wif }) => ({ label, wif })),
				onProgress: (p) => {
					seen.last = p;
					setProgress(p);
				},
				funding: plan.sweepFunding,
				ordinals: sweepOrdinals,
				bsv21Tokens: plan.sweepBsv21,
				bsv20Tokens: plan.sweepBsv20,
				logPrefix: "[sweep]",
			});
			const steps = seen.last?.steps ?? [];
			setRuns((prev) => [...prev, { result, steps, opnsNames }]);
			assets.rescan();
			toolbox.refreshBalance();
			setPhase("done");
		} catch (error) {
			reportMigrationFailure("wallet.sweep.run", error);
			setSweepError(
				error instanceof Error ? error.message : "The sweep could not start",
			);
			setPhase("review");
		}
	};

	if (toolbox.connectionMode === "external") {
		return (
			<Card>
				<CardContent className="py-8 text-center text-muted-foreground">
					Sweeping a key is available only for the wallet built into this
					browser.
				</CardContent>
			</Card>
		);
	}
	if (isWalletLocked || !walletKeys) {
		return (
			<Card>
				<CardContent className="py-8 text-center text-muted-foreground">
					Unlock your wallet to sweep a key into it.
				</CardContent>
			</Card>
		);
	}

	const lastRun = runs.at(-1);
	const fromLine = (
		<div className="flex items-center gap-3 text-sm">
			<div className="min-w-0 flex-1">
				<div className="text-xs text-muted-foreground">From</div>
				<div className="truncate font-medium">
					{source} · {plural(keys?.length ?? 0, "address", "addresses")}
				</div>
			</div>
			<ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
			<div className="min-w-0 flex-1 text-right">
				<div className="text-xs text-muted-foreground">To</div>
				<div className="font-medium">This wallet</div>
			</div>
			<InfoToggle
				open={showAddresses}
				onToggle={() => setShowAddresses((v) => !v)}
				label="Show scanned addresses"
			/>
		</div>
	);

	return (
		<div className="mx-auto max-w-xl space-y-4 pb-24">
			{phase === "input" && (
				<Card>
					<CardContent className="space-y-4 py-6">
						<div className="space-y-1">
							<p className="text-sm">
								Paste a private key (WIF), a key backup, or a recovery phrase.
								Everything it holds moves into this wallet.
							</p>
							<p className="text-xs text-muted-foreground">
								The key stays on this page and is never saved. A recovery phrase
								is checked at the RelayX path m/44&apos;/236&apos;/0&apos;/0/0.
							</p>
						</div>
						{locked ? (
							<form
								className="space-y-3"
								onSubmit={(e) => {
									e.preventDefault();
									void unlock();
								}}
							>
								<p className="text-sm">
									{locked.source} is encrypted. Enter its password.
								</p>
								<Input
									type="password"
									autoComplete="off"
									value={password}
									onChange={(e) => setPassword(e.target.value)}
									placeholder="Backup password"
								/>
								<div className="flex gap-2">
									<Button type="submit" disabled={reading || !password}>
										{reading && <Loader2 className="animate-spin" />}
										Unlock
									</Button>
									<Button type="button" variant="outline" onClick={reset}>
										Cancel
									</Button>
								</div>
							</form>
						) : (
							<>
								<Textarea
									value={text}
									onChange={(e) => setText(e.target.value)}
									placeholder="WIF, backup text or recovery phrase"
									autoComplete="off"
									autoCorrect="off"
									autoCapitalize="off"
									spellCheck={false}
									className="min-h-24 font-mono text-xs"
								/>
								<div className="flex flex-wrap gap-2">
									<Button
										onClick={() => void readInput(() => readSweepText(text))}
										disabled={reading || !text.trim()}
									>
										{reading && <Loader2 className="animate-spin" />}
										Find assets
									</Button>
									<Button
										variant="outline"
										onClick={() => fileRef.current?.click()}
										disabled={reading}
									>
										<FileUp />
										Choose backup file
									</Button>
									<input
										ref={fileRef}
										type="file"
										className="hidden"
										onChange={(e) => {
											const file = e.target.files?.[0];
											e.target.value = "";
											if (!file) return;
											void readInput(async () =>
												readSweepFile(
													new Uint8Array(await file.arrayBuffer()),
													file.name,
												),
											);
										}}
									/>
								</div>
							</>
						)}
						{inputError && (
							<p className="text-sm text-destructive">{inputError}</p>
						)}
					</CardContent>
				</Card>
			)}

			{phase !== "input" && keys && (
				<Card>
					<CardContent className="space-y-3 py-4">
						{fromLine}
						{showAddresses && (
							<AddressDetails keys={keys} status={assets.addressStatus} />
						)}
					</CardContent>
				</Card>
			)}

			{phase === "review" && keys && (
				<Card>
					<CardContent className="py-4">
						{assets.loading ? (
							<div className="space-y-2 py-2">
								<p className="text-sm">Looking for assets…</p>
								<p className="text-xs text-muted-foreground">
									{
										assets.addressStatus.filter((s) => s.state === "done")
											.length
									}{" "}
									of {plural(keys.length, "address", "addresses")} checked
								</p>
							</div>
						) : assets.error ? (
							<div className="space-y-3">
								<p className="text-sm text-destructive">
									The scan failed: {assets.error}
								</p>
								<Button variant="outline" onClick={assets.rescan}>
									Scan again
								</Button>
							</div>
						) : sweepCount === 0 && inactiveTokens.length === 0 ? (
							<p className="py-2 text-sm text-muted-foreground">
								Nothing to sweep at {keys.length === 1 ? "this" : "these"}{" "}
								{keys.length === 1 ? "address" : "addresses"}.
							</p>
						) : (
							<div className="divide-y divide-border/40">
								{plan.sweepFunding.length > 0 && (
									<AssetRow
										name="BSV"
										amount={formatBsv(
											plan.sweepFunding.reduce(
												(sum, o) => sum + (o.satoshis ?? 0),
												0,
											),
										)}
									/>
								)}
								{plainOrdinals > 0 && (
									<AssetRow
										name="Ordinals"
										amount={String(plainOrdinals)}
										note={
											listedCount > 0
												? `${listedCount} listed: the listing is cancelled`
												: undefined
										}
									/>
								)}
								{unlistedOpns.length > 0 && (
									<AssetRow
										name="OpNS names"
										amount={String(unlistedOpns.length)}
										note={unlistedOpns
											.map((o) => o.name ?? o.outpoint.slice(0, 12))
											.join(", ")}
									/>
								)}
								{plan.sweepBsv21.map((token) => (
									<AssetRow
										key={token.tokenId}
										name={token.symbol ?? token.tokenId.slice(0, 8)}
										amount={formatAmount(token.totalAmount, token.decimals)}
										note={
											token.isActive
												? undefined
												: "Not validated on the token overlay: skipped"
										}
									/>
								))}
								{plan.sweepBsv20.map((token) => (
									<AssetRow
										key={token.tick}
										name={token.tick}
										amount={formatAmount(token.totalAmount, token.decimals)}
									/>
								))}
								{assets.bsv20Unsweepable.length > 0 && (
									<AssetRow
										name="Unreadable BSV-20"
										amount={String(assets.bsv20Unsweepable.length)}
										note="Left in place: no confirmed ticker or amount"
									/>
								)}
								{notSwept > 0 && (
									<AssetRow
										name="Locked or RUN outputs"
										amount={String(notSwept)}
										note="Left in place: this tool does not move them"
									/>
								)}
							</div>
						)}
						{sweepError && (
							<p className="pt-3 text-sm text-destructive">{sweepError}</p>
						)}
					</CardContent>
				</Card>
			)}

			{phase === "sweeping" && (
				<Card>
					<CardContent className="space-y-3 py-4">
						<Progress value={progress?.percent ?? 0} />
						<p className="text-sm">{progress?.message ?? "Starting sweep…"}</p>
						<ul className="space-y-1.5">
							{(progress?.steps ?? []).map((step) => (
								<li key={step.id} className="flex items-center gap-2 text-sm">
									<StatusIcon status={step.status} />
									<span className="min-w-0 flex-1 truncate">{step.label}</span>
									{step.detail && (
										<span className="shrink-0 text-xs text-muted-foreground">
											{step.detail}
										</span>
									)}
								</li>
							))}
						</ul>
						<p className="text-xs text-muted-foreground">
							Keep this page open until the sweep finishes.
						</p>
					</CardContent>
				</Card>
			)}

			{phase === "done" && lastRun && (
				<Card>
					<CardContent className="space-y-3 py-4">
						<div className="flex items-center justify-between gap-2">
							<p className="text-sm font-medium">
								{lastRun.result.errors.length > 0
									? "Sweep finished with problems"
									: "Sweep complete"}
							</p>
							<InfoToggle
								open={showTxids}
								onToggle={() => setShowTxids((v) => !v)}
								label="Show transaction details"
							/>
						</div>
						<ul className="space-y-2">
							{lastRun.steps.map((step) => (
								<li key={step.id} className="flex items-start gap-2 text-sm">
									<StatusIcon status={step.status} />
									<div className="min-w-0 flex-1">
										<div>{step.label}</div>
										{step.id === "ordinals" && lastRun.opnsNames.length > 0 && (
											<div className="text-xs text-muted-foreground">
												Includes {lastRun.opnsNames.join(", ")}
											</div>
										)}
										{step.error && (
											<div className="text-xs text-destructive/90">
												{step.error}
											</div>
										)}
									</div>
								</li>
							))}
						</ul>
						{lastRun.result.errors.length > 0 && (
							<ul className="space-y-1 text-xs text-destructive/90">
								{lastRun.result.errors.map((error) => (
									<li key={error}>{error}</li>
								))}
							</ul>
						)}
						{assets.loading ? (
							<p className="text-xs text-muted-foreground">
								Checking what is left…
							</p>
						) : remaining > 0 ? (
							<p className="text-xs text-muted-foreground">
								{plural(remaining, "item")} still at{" "}
								{keys && keys.length === 1 ? "this address" : "these addresses"}
								.
							</p>
						) : null}
						{showTxids && <TxDetails runs={runs} chain={toolbox.chain} />}
					</CardContent>
				</Card>
			)}

			{phase !== "input" && (
				<div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap gap-2 border-t border-border/40 bg-background/95 px-1 py-3 backdrop-blur">
					{phase === "review" && (
						<Button
							className="flex-1"
							disabled={!scanReady || sweepCount === 0}
							onClick={() => void runSweep()}
						>
							{sweepCount > 0
								? `Sweep ${plural(sweepCount, "item")} into this wallet`
								: "Nothing to sweep"}
						</Button>
					)}
					{phase === "sweeping" && (
						<Button className="flex-1" disabled>
							<Loader2 className="animate-spin" />
							Sweeping…
						</Button>
					)}
					{phase === "done" && (
						<Button
							className="flex-1"
							onClick={() => {
								setProgress(null);
								setPhase("review");
								assets.rescan();
							}}
						>
							Rescan &amp; retry
						</Button>
					)}
					{phase !== "sweeping" && (
						<Button variant="outline" onClick={reset}>
							Another key
						</Button>
					)}
					{phase === "done" && (
						<Button variant="ghost" asChild>
							<Link href="/wallet">Wallet</Link>
						</Button>
					)}
				</div>
			)}
		</div>
	);
}
