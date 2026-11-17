"use client";

import { Check, ChevronRight, Copy, Download } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { Notice } from "@/components/ui/notice";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { CopyButton } from "@/components/wallet/sweep/sweep-details";
import { SWEEP_SHEET_LAYER } from "@/components/wallet/sweep/sweep-layers";
import { useIsMobile } from "@/hooks/use-mobile";
import {
	SWEEP_AUDIT_KIND_LABEL,
	SWEEP_AUDIT_STATUS_LABEL,
	type SweepAuditRecord,
	type SweepAuditStatus,
	sweepAuditFailed,
	sweepAuditFileName,
	sweepAuditJson,
	sweepAuditReportText,
	sweepAuditSummary,
	sweepAuditTransactions,
} from "@/lib/sweep-audit/record";
import { cn } from "@/lib/utils";
import { actionExplorerUrl } from "@/lib/wallet/action-history";

const formatDate = (iso: string) =>
	new Date(iso).toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-3">
			<h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
				{title}
			</h3>
			{children}
		</section>
	);
}

/** A txid that copies, and links to the explorer when it is one. */
function Txid({ txid, chain }: { txid: string; chain: "main" | "test" }) {
	const href = actionExplorerUrl(txid, chain);
	return (
		<span className="flex min-w-0 items-center gap-1">
			{href ? (
				<a
					href={href}
					target="_blank"
					rel="noopener noreferrer"
					className="min-w-0 flex-1 wrap-anywhere text-xs underline decoration-dotted underline-offset-2 hover:text-foreground"
				>
					{txid}
				</a>
			) : (
				<span className="min-w-0 flex-1 wrap-anywhere text-xs">{txid}</span>
			)}
			<CopyButton value={txid} label="txid" />
		</span>
	);
}

function StatusBadge({
	record,
	status,
}: {
	record: SweepAuditRecord;
	status: SweepAuditStatus;
}) {
	if (status === "interrupted")
		return <Badge variant="secondary">Interrupted</Badge>;
	if (status === "running") return <Badge variant="secondary">Running</Badge>;
	if (sweepAuditFailed(record))
		return <Badge variant="destructive">Failed</Badge>;
	return null;
}

/** Copy the plain-text report, or save the JSON record as a file. */
function ExportActions({
	record,
	status,
}: {
	record: SweepAuditRecord;
	status: SweepAuditStatus;
}) {
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const copy = () => {
		setError(null);
		navigator.clipboard.writeText(sweepAuditReportText(record, status)).then(
			() => {
				setCopied(true);
				window.setTimeout(() => setCopied(false), 1500);
			},
			(err: unknown) => {
				console.error("[sweep-audit] copy report failed", err);
				setError("Couldn't copy the report. Use Download instead.");
			},
		);
	};
	const download = () => {
		setError(null);
		try {
			const json = sweepAuditJson({ ...record, status });
			const url = URL.createObjectURL(
				new Blob([json], { type: "application/json" }),
			);
			const a = document.createElement("a");
			a.href = url;
			a.download = sweepAuditFileName(record);
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
		} catch (err) {
			console.error("[sweep-audit] download report failed", err);
			setError("Couldn't download the report. Use Copy report instead.");
		}
	};
	return (
		<div className="flex flex-col gap-2">
			<div className="flex gap-2">
				<Button variant="outline" className="flex-1" onClick={copy}>
					{copied ? (
						<Check data-icon="inline-start" className="text-success" />
					) : (
						<Copy data-icon="inline-start" />
					)}
					{copied ? "Copied" : "Copy report"}
				</Button>
				<Button variant="outline" className="flex-1" onClick={download}>
					<Download data-icon="inline-start" />
					Download
				</Button>
			</div>
			{error && <p className="text-destructive text-xs">{error}</p>}
		</div>
	);
}

/**
 * One run's full record, for wallet support: where it swept from, what the
 * scan found, every step with its txids and exact errors, and every output
 * it left behind with the reason.
 */
export function SweepAuditView({
	record,
	status = record.status,
}: {
	record: SweepAuditRecord;
	/** The status to show: a stale "running" record reads as interrupted. */
	status?: SweepAuditStatus;
}) {
	const txs = sweepAuditTransactions(record);
	// Step txids show under their step; the rest (listing cancels, moves to
	// the identity key) get their own list.
	const stepTxids = new Set(record.steps.flatMap((step) => step.txids));
	const otherTxs = txs.filter((tx) => !stepTxids.has(tx.txid));
	const errorCounts = [
		...record.errors
			.reduce(
				(counts, error) => counts.set(error, (counts.get(error) ?? 0) + 1),
				new Map<string, number>(),
			)
			.entries(),
	];
	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-3">
				<div className="flex items-center gap-2">
					<p className="font-medium text-sm">
						{SWEEP_AUDIT_KIND_LABEL[record.kind]}
					</p>
					<StatusBadge record={record} status={status} />
				</div>
				<ExportActions record={record} status={status} />
				<p className="text-muted-foreground text-xs">
					Share this with wallet support. It holds addresses, transaction ids
					and errors, never your keys.
				</p>
			</div>

			<Section title="Run">
				<DetailList>
					<DetailRow label="Status" mono={false}>
						{SWEEP_AUDIT_STATUS_LABEL[status]}
					</DetailRow>
					<DetailRow label="Started" mono={false}>
						{formatDate(record.startedAt)}
					</DetailRow>
					{record.finishedAt && (
						<DetailRow label="Finished" mono={false}>
							{formatDate(record.finishedAt)}
						</DetailRow>
					)}
					<DetailRow label="Network" mono={false}>
						{record.chain === "main" ? "Mainnet" : "Testnet"}
					</DetailRow>
					<DetailRow label="App">
						{record.app.version}
						{record.app.commit ? ` (${record.app.commit.slice(0, 12)})` : ""}
					</DetailRow>
					<DetailRow label="Run id">{record.id}</DetailRow>
				</DetailList>
				{record.failure && <Notice tone="danger">{record.failure}</Notice>}
			</Section>

			<Section title="Sources">
				<DetailList>
					{record.sources.map((source) => (
						<DetailRow
							key={source.address}
							label={`${source.label} · ${source.scheme}`}
							stack
						>
							<span className="flex min-w-0 items-center gap-1">
								<span className="min-w-0 flex-1 wrap-anywhere text-xs">
									{source.address}
								</span>
								<CopyButton value={source.address} label={source.label} />
							</span>
						</DetailRow>
					))}
					<DetailRow label="Destination" mono={false} stack>
						{record.destination}
					</DetailRow>
				</DetailList>
			</Section>

			<Section title="Scan">
				<DetailList>
					{record.scan
						.filter((count) => count.found > 0)
						.map((count) => (
							<DetailRow key={count.kind} label={count.kind} mono={false}>
								{count.selected} of {count.found} selected
							</DetailRow>
						))}
				</DetailList>
				{record.scan.every((count) => count.found === 0) && (
					<p className="text-muted-foreground text-sm">Nothing found.</p>
				)}
			</Section>

			{record.stages.length > 0 && (
				<Section title="Stages">
					<DetailList>
						{record.stages.map((stage) => (
							<DetailRow
								key={`${stage.stage}:${stage.at}`}
								label={stage.stage}
								mono={false}
							>
								{formatDate(stage.at)}
							</DetailRow>
						))}
					</DetailList>
				</Section>
			)}

			<Section title={`Steps (${record.steps.length})`}>
				{record.steps.length === 0 && (
					<p className="text-muted-foreground text-sm">No sweep steps ran.</p>
				)}
				<ul className="flex flex-col gap-4">
					{record.steps.map((step) => (
						<li key={step.id} className="flex flex-col gap-2">
							<p className="flex items-center gap-2 text-sm">
								<span className="font-medium">{step.label}</span>
								<span
									className={cn(
										"text-xs",
										step.status === "error"
											? "text-destructive"
											: "text-muted-foreground",
									)}
								>
									{step.status}
								</span>
							</p>
							{step.error && (
								<p className="text-destructive text-xs">{step.error}</p>
							)}
							{step.txids.map((txid) => (
								<Txid key={txid} txid={txid} chain={record.chain} />
							))}
						</li>
					))}
				</ul>
			</Section>

			{txs.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					No transactions were sent.
				</p>
			) : (
				otherTxs.length > 0 && (
					<Section title={`Other transactions (${otherTxs.length})`}>
						<DetailList>
							{otherTxs.map((tx) => (
								<DetailRow key={tx.txid} label={tx.label} stack>
									<Txid txid={tx.txid} chain={record.chain} />
								</DetailRow>
							))}
						</DetailList>
					</Section>
				)
			)}

			{record.leftBehind.length > 0 && (
				<Section title={`Left behind (${record.leftBehind.length})`}>
					<ul className="flex max-h-96 flex-col gap-2 overflow-y-auto rounded-md bg-muted/50 p-2">
						{record.leftBehind.map((item) => (
							<li
								key={`${item.stage}:${item.outpoint}`}
								className="flex flex-col gap-0.5"
							>
								<span className="wrap-anywhere font-mono text-[11px]">
									{item.outpoint}
								</span>
								<span className="wrap-anywhere text-muted-foreground text-xs">
									{item.kind ? `${item.kind}: ` : ""}
									{item.reason}
								</span>
							</li>
						))}
					</ul>
				</Section>
			)}

			{record.errors.length > 0 && (
				<Section title={`Errors (${record.errors.length})`}>
					<ul className="flex flex-col gap-2">
						{errorCounts.map(([error, count]) => (
							<li
								key={error}
								className="wrap-anywhere rounded-md bg-destructive/10 p-2 font-mono text-[11px] text-destructive"
							>
								{error}
								{count > 1 ? ` (×${count})` : ""}
							</li>
						))}
					</ul>
				</Section>
			)}
		</div>
	);
}

/** This wallet's runs, newest first; each opens its record. */
export function SweepAuditList({
	records,
	statusOf,
	onOpen,
}: {
	records: SweepAuditRecord[];
	statusOf: (record: SweepAuditRecord) => SweepAuditStatus;
	onOpen: (record: SweepAuditRecord) => void;
}) {
	return (
		<ul className="divide-y overflow-hidden rounded-xl border bg-card">
			{records.map((record) => {
				const status = statusOf(record);
				return (
					<li key={record.id}>
						<button
							type="button"
							onClick={() => onOpen(record)}
							className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50"
						>
							<span className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="flex items-center gap-2 font-medium text-sm">
									{SWEEP_AUDIT_KIND_LABEL[record.kind]}
									<StatusBadge record={record} status={status} />
								</span>
								<span className="text-muted-foreground text-xs">
									{formatDate(record.startedAt)} · {sweepAuditSummary(record)}
								</span>
							</span>
							<ChevronRight
								aria-hidden="true"
								className="size-4 shrink-0 text-muted-foreground"
							/>
						</button>
					</li>
				);
			})}
		</ul>
	);
}

/**
 * The quiet "Support report" link a finished sweep shows: opens this run's
 * record in a sheet, in front of the first-run dialog too.
 */
export function SweepSupportReport({
	record,
	saveError,
}: {
	record: SweepAuditRecord | null;
	saveError?: string | null;
}) {
	const [open, setOpen] = useState(false);
	const isMobile = useIsMobile();
	if (!record) return null;
	return (
		<div className="flex flex-col items-center gap-1">
			<button
				type="button"
				className="text-muted-foreground text-xs underline underline-offset-4 hover:text-foreground"
				onClick={() => setOpen(true)}
			>
				Support report
			</button>
			{saveError && (
				<p className="text-center text-destructive text-xs">{saveError}</p>
			)}
			<Sheet open={open} onOpenChange={setOpen}>
				<SheetContent
					side={isMobile ? "bottom" : "right"}
					overlayClassName={SWEEP_SHEET_LAYER}
					className={cn(
						SWEEP_SHEET_LAYER,
						isMobile ? "max-h-[85dvh] rounded-t-xl" : "w-full sm:max-w-md",
					)}
				>
					<SheetHeader className="pr-12">
						<SheetTitle>Support report</SheetTitle>
						<SheetDescription>
							A record of this run, kept in this browser. Every run is also
							under Wallet settings, Sweep history.
						</SheetDescription>
					</SheetHeader>
					<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
						<SweepAuditView record={record} />
					</div>
				</SheetContent>
			</Sheet>
		</div>
	);
}
