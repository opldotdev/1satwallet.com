import type { BuildInfo } from "@/lib/build-info";
import type {
	SweepLeftBehind,
	SweepProgress,
	SweepResult,
	SweepStepState,
} from "@/lib/sweep-migration";

/*
 * The audit record of one sweep run, kept in this browser so the user can
 * hand it to wallet support. It is built only from addresses, labels, counts,
 * outpoints, txids and error strings: no builder here takes a key, a phrase,
 * a password or a wallet, so none can end up in a record. As a second guard,
 * every string is passed through redactSecrets before it is stored or
 * exported.
 */

export const SWEEP_AUDIT_FORMAT = "1sat-sweep-audit";
export const SWEEP_AUDIT_VERSION = 1;

export type SweepAuditKind = "migration" | "key-sweep";
export type SweepAuditStatus = "running" | "finished" | "interrupted";

/** One address a run swept from: what it is and how it was derived. */
export interface SweepAuditSource {
	address: string;
	/** e.g. "Legacy pay" or "Private key" */
	label: string;
	/** e.g. "original 1Sat payPk" or "pasted key (WIF)" */
	scheme: string;
}

/** One class of output the scan found, and how many of them the run took. */
export interface SweepAuditCount {
	kind: string;
	found: number;
	selected: number;
}

export interface SweepAuditStep {
	id: string;
	label: string;
	status: SweepStepState["status"];
	txids: string[];
	/** The step's short summary, e.g. "1 of 2 batches failed" */
	error: string | null;
	/** Every error the step raised, verbatim */
	errors: string[];
}

/** An output the run left at its address. */
export interface SweepAuditLeftBehind {
	outpoint: string;
	/** What kind of output it is, when the plan knows */
	kind?: string;
	/** Exact reason: the user's choice, or the error that kept it there */
	reason: string;
	/** "plan": never sent to the sweep; "sweep": the sweep left it */
	stage: "plan" | "sweep";
}

export interface SweepAuditTxids {
	/** Listings cancelled before the sweep */
	cancel: string[];
	/** Moves from the pay-key wallet to the identity root */
	transfer: string[];
	bsv: string[];
	ordinals: string[];
	bsv20: string[];
	bsv21: string[];
}

export interface SweepAuditRecord {
	format: typeof SWEEP_AUDIT_FORMAT;
	version: typeof SWEEP_AUDIT_VERSION;
	id: string;
	/** The wallet's public identity key; records are listed per wallet */
	identityKey: string;
	kind: SweepAuditKind;
	chain: "main" | "test";
	status: SweepAuditStatus;
	startedAt: string;
	finishedAt: string | null;
	app: BuildInfo;
	sources: SweepAuditSource[];
	destination: string;
	scan: SweepAuditCount[];
	/** Run stages reached before the sweep (cancel, transfer, reroot...) */
	stages: { stage: string; at: string }[];
	steps: SweepAuditStep[];
	txids: SweepAuditTxids;
	leftBehind: SweepAuditLeftBehind[];
	/** SweepResult.errors, verbatim */
	errors: string[];
	/** Listed legacy outputs whose listing was cancelled inside a sweep spend */
	cancelledListings: string[];
	/** Why the run stopped, when it threw */
	failure: string | null;
}

/** What a run is known to be before it starts. Addresses only, never keys. */
export interface SweepAuditInit {
	identityKey: string;
	kind: SweepAuditKind;
	chain: "main" | "test";
	app: BuildInfo;
	sources: SweepAuditSource[];
	destination: string;
	scan: SweepAuditCount[];
	/** Outputs the plan leaves out: deselected, or kept where they are */
	planLeftBehind: Omit<SweepAuditLeftBehind, "stage">[];
}

/**
 * WIF-shaped strings: base58check private keys (mainnet 5/K/L, testnet 9/c).
 * Addresses (25-34 chars), txids and outpoints (hex) never match.
 */
const WIF_SHAPE = /\b[59KLc][1-9A-HJ-NP-Za-km-z]{50,51}\b/g;

/** Replace anything shaped like a private key, recursively. */
export function redactSecrets<T>(value: T): T {
	if (typeof value === "string") {
		return value.replace(WIF_SHAPE, "[redacted key]") as T;
	}
	if (Array.isArray(value)) {
		return value.map((item) => redactSecrets(item)) as T;
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, redactSecrets(item)]),
		) as T;
	}
	return value;
}

const emptyTxids = (): SweepAuditTxids => ({
	cancel: [],
	transfer: [],
	bsv: [],
	ordinals: [],
	bsv20: [],
	bsv21: [],
});

export function createSweepAuditRecord(
	init: SweepAuditInit,
	id: string,
	now: Date,
): SweepAuditRecord {
	return redactSecrets({
		format: SWEEP_AUDIT_FORMAT,
		version: SWEEP_AUDIT_VERSION,
		id,
		identityKey: init.identityKey,
		kind: init.kind,
		chain: init.chain,
		status: "running",
		startedAt: now.toISOString(),
		finishedAt: null,
		app: { version: init.app.version, commit: init.app.commit },
		sources: init.sources.map(({ address, label, scheme }) => ({
			address,
			label,
			scheme,
		})),
		destination: init.destination,
		scan: init.scan.map(({ kind, found, selected }) => ({
			kind,
			found,
			selected,
		})),
		stages: [],
		steps: [],
		txids: emptyTxids(),
		leftBehind: init.planLeftBehind.map((item) => ({
			outpoint: item.outpoint,
			...(item.kind ? { kind: item.kind } : {}),
			reason: item.reason,
			stage: "plan" as const,
		})),
		errors: [],
		cancelledListings: [],
		failure: null,
	});
}

export function withSweepStage(
	record: SweepAuditRecord,
	stage: string,
	now: Date,
): SweepAuditRecord {
	return {
		...record,
		stages: [...record.stages, { stage, at: now.toISOString() }],
	};
}

const auditSteps = (steps: readonly SweepStepState[]): SweepAuditStep[] =>
	steps.map((step) => ({
		id: step.id,
		label: step.label,
		status: step.status,
		txids: [...step.txids],
		error: step.error ?? null,
		errors: [...(step.errors ?? [])],
	}));

const sweepLeftBehind = (
	items: readonly SweepLeftBehind[],
): SweepAuditLeftBehind[] =>
	items.map((item) => ({
		outpoint: item.outpoint,
		...(item.stepId ? { kind: item.stepId } : {}),
		reason: item.reason,
		stage: "sweep" as const,
	}));

const withSweepLeftBehind = (
	record: SweepAuditRecord,
	items: readonly SweepLeftBehind[],
): SweepAuditLeftBehind[] => [
	...record.leftBehind.filter((item) => item.stage === "plan"),
	...sweepLeftBehind(items),
];

/** The run as the sweep's latest progress report has it. */
export function withSweepProgress(
	record: SweepAuditRecord,
	progress: SweepProgress,
): SweepAuditRecord {
	return redactSecrets({
		...record,
		steps: auditSteps(progress.steps),
		errors: [...(progress.errors ?? record.errors)],
		leftBehind: progress.leftBehind
			? withSweepLeftBehind(record, progress.leftBehind)
			: record.leftBehind,
	});
}

/** The run's whole result: every txid, error and leftover, verbatim. */
export function finishSweepAudit(
	record: SweepAuditRecord,
	outcome: {
		result: SweepResult | null;
		/** The sweep's last steps, when it reported any */
		steps?: readonly SweepStepState[];
		/** Why the run stopped, when it threw */
		failure?: string;
	},
	now: Date,
): SweepAuditRecord {
	const { result } = outcome;
	return redactSecrets({
		...record,
		status: "finished",
		finishedAt: now.toISOString(),
		steps: outcome.steps ? auditSteps(outcome.steps) : record.steps,
		txids: result
			? {
					cancel: [...(result.cancelTxids ?? [])],
					transfer: [...(result.transferTxids ?? [])],
					bsv: [...result.bsvTxids],
					ordinals: [...result.ordinalTxids],
					bsv20: [...result.bsv20Txids],
					bsv21: [...result.bsv21Txids],
				}
			: record.txids,
		errors: result ? [...result.errors] : record.errors,
		leftBehind: result?.leftBehind
			? withSweepLeftBehind(record, result.leftBehind)
			: record.leftBehind,
		cancelledListings: result
			? [...result.cancelledListings]
			: record.cancelledListings,
		failure: outcome.failure ?? null,
	});
}

/** A record still "running" that no open page is running reads as interrupted. */
export function effectiveSweepAuditStatus(
	record: SweepAuditRecord,
	runningHere: ReadonlySet<string>,
): SweepAuditStatus {
	return record.status === "running" && !runningHere.has(record.id)
		? "interrupted"
		: record.status;
}

const TXID_GROUPS: [keyof SweepAuditTxids, string][] = [
	["cancel", "Listing cancelled"],
	["transfer", "Moved to identity key"],
	["bsv", "BSV"],
	["ordinals", "Ordinals"],
	["bsv20", "BSV-20 tokens"],
	["bsv21", "Tokens"],
];

/**
 * Every transaction the run broadcast, labelled. Steps give txids as they
 * happen (a run interrupted mid-sweep has no result), the result the rest.
 */
export function sweepAuditTransactions(
	record: SweepAuditRecord,
): { label: string; txid: string }[] {
	const seen = new Set<string>();
	const out: { label: string; txid: string }[] = [];
	const add = (label: string, txid: string) => {
		if (seen.has(txid)) return;
		seen.add(txid);
		out.push({ label, txid });
	};
	for (const [key, label] of TXID_GROUPS.slice(0, 2)) {
		for (const txid of record.txids[key]) add(label, txid);
	}
	for (const step of record.steps) {
		for (const txid of step.txids) add(step.label, txid);
	}
	for (const [key, label] of TXID_GROUPS.slice(2)) {
		for (const txid of record.txids[key]) add(label, txid);
	}
	return out;
}

/** Whether anything in the run went wrong. */
export function sweepAuditFailed(record: SweepAuditRecord): boolean {
	return (
		record.failure !== null ||
		record.errors.length > 0 ||
		record.steps.some((step) => step.status === "error")
	);
}

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "2 transactions, 3 left behind" */
export function sweepAuditSummary(record: SweepAuditRecord): string {
	const txs = sweepAuditTransactions(record).length;
	const left = record.leftBehind.length;
	return `${plural(txs, "transaction")}, ${left.toLocaleString("en-US")} left behind`;
}

export const SWEEP_AUDIT_KIND_LABEL: Record<SweepAuditKind, string> = {
	migration: "Wallet migration",
	"key-sweep": "Key sweep",
};

export const SWEEP_AUDIT_STATUS_LABEL: Record<SweepAuditStatus, string> = {
	running: "Running",
	finished: "Finished",
	interrupted: "Interrupted (the page closed before the run finished)",
};

/** The record as a JSON file's text. */
export function sweepAuditJson(record: SweepAuditRecord): string {
	return `${JSON.stringify(redactSecrets(record), null, 2)}\n`;
}

/** A file name for the record's download. */
export function sweepAuditFileName(record: SweepAuditRecord): string {
	const stamp = record.startedAt.replace(/[:.]/g, "-");
	return `1sat-sweep-report-${stamp}.json`;
}

/** The record as plain text, for pasting into a message to support. */
export function sweepAuditReportText(
	record: SweepAuditRecord,
	status: SweepAuditStatus = record.status,
): string {
	const lines: string[] = [];
	const section = (title: string) => {
		lines.push("", `## ${title}`);
	};
	lines.push(
		`1Sat wallet sweep report (${SWEEP_AUDIT_KIND_LABEL[record.kind]})`,
		`Run: ${record.id}`,
		`Status: ${SWEEP_AUDIT_STATUS_LABEL[status]}`,
		`Started: ${record.startedAt}`,
		`Finished: ${record.finishedAt ?? "-"}`,
		`Network: ${record.chain === "main" ? "mainnet" : "testnet"}`,
		`App: ${record.app.version}${record.app.commit ? ` (${record.app.commit})` : ""}`,
		`Wallet identity key: ${record.identityKey}`,
		`Destination: ${record.destination}`,
	);
	if (record.failure) lines.push(`Stopped with: ${record.failure}`);

	section("Sources");
	for (const source of record.sources) {
		lines.push(`- ${source.label} [${source.scheme}]: ${source.address}`);
	}

	section("Scan");
	for (const count of record.scan) {
		lines.push(
			`- ${count.kind}: found ${count.found}, selected ${count.selected}`,
		);
	}

	if (record.stages.length > 0) {
		section("Stages");
		for (const stage of record.stages) {
			lines.push(`- ${stage.at} ${stage.stage}`);
		}
	}

	section("Steps");
	if (record.steps.length === 0) lines.push("- none");
	for (const step of record.steps) {
		lines.push(`- ${step.label}: ${step.status}`);
		if (step.error) lines.push(`    ${step.error}`);
		for (const txid of step.txids) lines.push(`    tx ${txid}`);
		for (const error of step.errors) lines.push(`    error: ${error}`);
	}

	section("Transactions");
	const txs = sweepAuditTransactions(record);
	if (txs.length === 0) lines.push("- none");
	for (const tx of txs) lines.push(`- ${tx.label}: ${tx.txid}`);

	if (record.cancelledListings.length > 0) {
		section("Listings cancelled inside a sweep");
		for (const outpoint of record.cancelledListings) {
			lines.push(`- ${outpoint}`);
		}
	}

	section(`Left behind (${record.leftBehind.length})`);
	if (record.leftBehind.length === 0) lines.push("- none");
	for (const item of record.leftBehind) {
		lines.push(
			`- ${item.outpoint}${item.kind ? ` [${item.kind}]` : ""}: ${item.reason}`,
		);
	}

	section(`Errors (${record.errors.length})`);
	if (record.errors.length === 0) lines.push("- none");
	for (const error of record.errors) lines.push(`- ${error}`);

	return `${redactSecrets(lines.join("\n"))}\n`;
}
