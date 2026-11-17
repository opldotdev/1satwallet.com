/**
 * Pure view-model helpers for the legacy sweep wizard. Nothing here decides
 * what is scanned, planned or swept: it only turns the scan, the selection,
 * the sweep's progress and its result into steps and short, readable lines.
 */

import type { SweepProgress, SweepResult } from "@/lib/sweep-migration";
import { cancelledListingCount } from "@/lib/sweep-migration";
import type { AssetType } from "@/lib/wallet/migration-listings";

const SATS_PER_BSV = 100_000_000;

const plural = (n: number, one: string, many = `${one}s`) =>
	`${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function formatSats(sats: number): string {
	return sats.toLocaleString("en-US");
}

/** Sats as BSV, every significant digit kept, trailing zeros dropped. */
export function formatBsv(sats: number): string {
	const whole = Math.trunc(sats / SATS_PER_BSV);
	const frac = Math.abs(sats % SATS_PER_BSV)
		.toString()
		.padStart(8, "0")
		.replace(/0+$/, "");
	const sign = sats < 0 && whole === 0 ? "-" : "";
	const int = `${sign}${whole.toLocaleString("en-US")}`;
	return frac ? `${int}.${frac}` : int;
}

const groupDigits = (digits: string) =>
	digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** A raw token amount at its decimals, digits grouped, trailing zeros dropped. */
export function formatTokenAmount(
	rawAmount: string | bigint,
	decimals: number,
): string {
	const raw = rawAmount.toString();
	const negative = raw.startsWith("-");
	const digits = negative ? raw.slice(1) : raw;
	const sign = negative ? "-" : "";
	if (decimals <= 0) return `${sign}${groupDigits(digits)}`;
	const padded = digits.padStart(decimals + 1, "0");
	const intPart = padded.slice(0, -decimals).replace(/^0+(?=\d)/, "") || "0";
	const decPart = padded.slice(-decimals).replace(/0+$/, "");
	const int = groupDigits(intPart);
	return decPart ? `${sign}${int}.${decPart}` : `${sign}${int}`;
}

// ---------------------------------------------------------------------------
// What a scan found
// ---------------------------------------------------------------------------

interface OutpointLike {
	outpoint: string;
}

/** An ordinal or OpNS name as the sweep screens show it. */
export interface SweepOrdinal extends OutpointLike {
	contentUrl: string;
	contentType?: string;
	name?: string;
}

interface TokenLike {
	totalAmount: bigint;
	decimals: number;
	outputs: unknown[];
}

export interface SweepSummaryInput {
	funding: unknown[];
	totalBsv: number;
	/** Unlisted ordinals (listings are counted on their own). */
	ordinals: SweepOrdinal[];
	/** Unlisted OpNS names. */
	opnsNames: SweepOrdinal[];
	bsv21Tokens: (TokenLike & {
		tokenId: string;
		symbol?: string;
		icon?: string;
		isActive: boolean;
	})[];
	bsv20Balances: (TokenLike & { tick: string })[];
	listings: number;
	bsv20Unsweepable: { output: OutpointLike; reason: string }[];
	locked: OutpointLike[];
	run: OutpointLike[];
}

export interface SweepThumb {
	key: string;
	contentUrl: string;
	contentType?: string;
	name?: string;
}

export interface SweepTokenLine {
	key: string;
	kind: "bsv21" | "bsv20";
	ticker: string;
	amount: string;
	icon?: string;
	outputCount: number;
}

export interface SweepSummary {
	bsv: { sats: number; bsv: string; satsLabel: string; utxos: number } | null;
	ordinals: { count: number; thumbs: SweepThumb[]; more: number };
	names: { count: number; preview: string[]; more: number };
	/** Tokens the sweep moves: validated BSV-21 and indexed BSV-20. */
	tokens: SweepTokenLine[];
	/** BSV-21 tokens not validated on the overlay: the sweep skips them. */
	inactiveTokens: { key: string; ticker: string; outputCount: number }[];
	/** BSV-20 outputs the sweep leaves at the old address. */
	bsv20Unconfirmed: string[];
	locked: string[];
	run: string[];
	listings: number;
}

export const THUMB_STRIP_MAX = 5;
export const NAME_PREVIEW_MAX = 2;

export function buildSweepSummary(
	input: SweepSummaryInput,
	maxThumbs = THUMB_STRIP_MAX,
): SweepSummary {
	const thumbs = input.ordinals.slice(0, maxThumbs).map((o) => ({
		key: o.outpoint,
		contentUrl: o.contentUrl,
		contentType: o.contentType,
		name: o.name,
	}));
	const names = input.opnsNames.map((n) => n.name || n.outpoint.slice(0, 12));
	const tokenTicker = (t: { tokenId: string; symbol?: string }) =>
		t.symbol || t.tokenId.slice(0, 8);
	return {
		bsv:
			input.totalBsv > 0
				? {
						sats: input.totalBsv,
						bsv: formatBsv(input.totalBsv),
						satsLabel: `${formatSats(input.totalBsv)} sats`,
						utxos: input.funding.length,
					}
				: null,
		ordinals: {
			count: input.ordinals.length,
			thumbs,
			more: Math.max(0, input.ordinals.length - thumbs.length),
		},
		names: {
			count: names.length,
			preview: names.slice(0, NAME_PREVIEW_MAX),
			more: Math.max(0, names.length - NAME_PREVIEW_MAX),
		},
		tokens: [
			...input.bsv21Tokens
				.filter((t) => t.isActive)
				.map((t) => ({
					key: `bsv21:${t.tokenId}`,
					kind: "bsv21" as const,
					ticker: tokenTicker(t),
					amount: formatTokenAmount(t.totalAmount, t.decimals),
					icon: t.icon,
					outputCount: t.outputs.length,
				})),
			...input.bsv20Balances.map((t) => ({
				key: `bsv20:${t.tick}`,
				kind: "bsv20" as const,
				ticker: t.tick,
				amount: formatTokenAmount(t.totalAmount, t.decimals),
				outputCount: t.outputs.length,
			})),
		],
		inactiveTokens: input.bsv21Tokens
			.filter((t) => !t.isActive)
			.map((t) => ({
				key: `inactive:${t.tokenId}`,
				ticker: tokenTicker(t),
				outputCount: t.outputs.length,
			})),
		bsv20Unconfirmed: input.bsv20Unsweepable.map((u) => u.output.outpoint),
		locked: input.locked.map((o) => o.outpoint),
		run: input.run.map((o) => o.outpoint),
		listings: input.listings,
	};
}

// ---------------------------------------------------------------------------
// Wizard steps
// ---------------------------------------------------------------------------

export type WizardStepId =
	| "bsv"
	| "collectibles"
	| "tokens"
	| "stays"
	| "review";

/** The steps worth showing for this scan, in order; review is always last. */
export function buildWizardSteps(summary: SweepSummary): WizardStepId[] {
	const steps: WizardStepId[] = [];
	if (summary.bsv) steps.push("bsv");
	if (summary.ordinals.count + summary.names.count > 0)
		steps.push("collectibles");
	if (summary.tokens.length > 0) steps.push("tokens");
	if (staysCount(summary) + summary.listings > 0) steps.push("stays");
	steps.push("review");
	return steps;
}

/** The screen a host's migration phase shows. One mapping for both hosts. */
export type SweepScreen = "scan" | "steps" | "progress" | "done" | "error";

export function sweepScreenFor(phase: string): SweepScreen {
	switch (phase) {
		case "preview":
			return "steps";
		case "migrate":
			return "progress";
		case "complete":
			return "done";
		case "error":
			return "error";
		default:
			return "scan";
	}
}

// ---------------------------------------------------------------------------
// What stays where it is
// ---------------------------------------------------------------------------

export interface StayRow {
	key: string;
	kind: "bsv20" | "inactive" | "locked" | "run" | "listings";
	/** One short line for the screen. */
	label: string;
	count: number;
	/** The longer reason, for the Details sheet. */
	detail: string;
	outpoints: string[];
}

export const BSV20_STAYS_LINE =
	"The indexer can't confirm these amounts, so sweeping could burn them.";
export const BSV20_STAYS_DETAIL =
	"These are BSV-20 mint and transfer inscriptions. The indexer this wallet uses doesn't track BSV-20, so their balances can't be verified. A sweep that claims more than an output really holds destroys the tokens, so they're left untouched. Your old keys stay in this wallet.";

/** Items the sweep leaves at the old addresses, never counting listings. */
export function staysCount(summary: SweepSummary): number {
	return (
		summary.bsv20Unconfirmed.length +
		summary.inactiveTokens.reduce((n, t) => n + t.outputCount, 0) +
		summary.locked.length +
		summary.run.length
	);
}

/** One row per reason something stays put, BSV-20 merged into one group. */
export function staysRows(summary: SweepSummary): StayRow[] {
	const rows: StayRow[] = [];
	if (summary.bsv20Unconfirmed.length > 0) {
		rows.push({
			key: "bsv20",
			kind: "bsv20",
			label: "BSV-20 inscriptions",
			count: summary.bsv20Unconfirmed.length,
			detail: BSV20_STAYS_DETAIL,
			outpoints: summary.bsv20Unconfirmed,
		});
	}
	for (const token of summary.inactiveTokens) {
		rows.push({
			key: token.key,
			kind: "inactive",
			label: `${token.ticker}: not validated on the overlay, skipped.`,
			count: token.outputCount,
			detail:
				"This token isn't active on the token overlay, so the sweep can't move it. It stays at your old address.",
			outpoints: [],
		});
	}
	if (summary.locked.length > 0) {
		rows.push({
			key: "locked",
			kind: "locked",
			label: `${plural(summary.locked.length, "time-locked output")}: sweep them after they unlock.`,
			count: summary.locked.length,
			detail:
				"Time-locked on chain. They can be swept once the lock height passes.",
			outpoints: summary.locked,
		});
	}
	if (summary.run.length > 0) {
		rows.push({
			key: "run",
			kind: "run",
			label: `${plural(summary.run.length, "RUN output")}: kept out of the BSV sweep so their token state isn't spent as fees.`,
			count: summary.run.length,
			detail:
				"RUN protocol outputs are left out of the BSV sweep so their token state is not destroyed as fees.",
			outpoints: summary.run,
		});
	}
	if (summary.listings > 0) {
		rows.push({
			key: "listings",
			kind: "listings",
			label: `${plural(summary.listings, "listing")} ${summary.listings === 1 ? "is" : "are"} cancelled, then the ordinals move.`,
			count: summary.listings,
			detail:
				"Open OrdLock listings are cancelled first; each ordinal then moves with the rest.",
			outpoints: [],
		});
	}
	return rows;
}

/** "N BSV-20 inscriptions stay at your old address (still yours)". */
export function bsv20StaysLine(count: number): string | null {
	if (count === 0) return null;
	return `${plural(count, "BSV-20 inscription")} stay at your old address (still yours)`;
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export interface ReviewLine {
	step: WizardStepId;
	label: string;
	value: string;
}

/** One receipt line per included class, each jumping back to its step. */
export function reviewLines(
	summary: SweepSummary,
	types: ReadonlySet<AssetType>,
	selectedOrdinals: number,
): ReviewLine[] {
	const lines: ReviewLine[] = [];
	if (summary.bsv && types.has("bsv")) {
		lines.push({ step: "bsv", label: "BSV", value: `${summary.bsv.bsv} BSV` });
	}
	if (types.has("ordinals")) {
		const parts = [
			selectedOrdinals > 0 ? plural(selectedOrdinals, "ordinal") : null,
			summary.names.count > 0 ? plural(summary.names.count, "name") : null,
		].filter(Boolean);
		if (parts.length > 0) {
			lines.push({
				step: "collectibles",
				label: "Collectibles",
				value: parts.join(" · "),
			});
		}
	}
	const tokens = summary.tokens.filter((t) => types.has(t.kind));
	if (tokens.length > 0) {
		lines.push({
			step: "tokens",
			label: "Tokens",
			value:
				tokens.length <= 2
					? tokens.map((t) => `${t.amount} ${t.ticker}`).join(" · ")
					: plural(tokens.length, "token"),
		});
	}
	if (summary.listings > 0 && types.has("listings")) {
		lines.push({
			step: "stays",
			label: "Listings",
			value: `Cancel ${summary.listings}`,
		});
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Live progress
// ---------------------------------------------------------------------------

function stepAction(step: { id: string; label: string }): string {
	if (step.id === "bsv") return "Moving BSV";
	if (step.id === "ordinals") return "Moving ordinals";
	// Token steps are labelled "TICK (N outputs)".
	return `Moving ${step.label.replace(/\s*\([^)]*\)\s*$/, "")}`;
}

/**
 * One line for the sweep in flight: "Step 2 of 5: Moving ordinals (batch 2/5)".
 * Before the sweep reports steps (key derivation, listing cancels), the
 * caller's stage message is shown instead.
 */
export function currentStepLine(
	progress: SweepProgress | null,
	fallback: string,
): string {
	const steps = progress?.steps ?? [];
	if (steps.length === 0) return fallback;
	let index = steps.findIndex((s) => s.status === "active");
	if (index === -1) {
		const pending = steps.findIndex((s) => s.status === "pending");
		if (pending === -1) return "Finishing up";
		index = pending;
	}
	const step = steps[index];
	const batch = step.detail?.match(/\(batch (\d+\/\d+)\)/)?.[1];
	return `Step ${index + 1} of ${steps.length}: ${stepAction(step)}${
		batch ? ` (batch ${batch})` : ""
	}`;
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

export type OutcomeStatus = "done" | "partial" | "failed";

export interface OutcomeRow {
	key: string;
	label: string;
	status: OutcomeStatus;
	/** Short, plain status text. */
	note: string;
}

export interface SweepOutcome {
	kind: "all-moved" | "moved-with-left" | "nothing" | "failed";
	headline: string;
	rows: OutcomeRow[];
	/** Plain reasons for what didn't move, one per kind of failure. */
	notes: string[];
	/** Items a fresh scan still finds at the old addresses. */
	remaining: number;
	errorCount: number;
}

function rowLabel(step: { id: string; label: string }): string {
	if (step.id === "bsv") return "BSV";
	if (step.id === "ordinals") return "Ordinals & names";
	return step.label.replace(/\s*\([^)]*\)\s*$/, "");
}

const OUTCOME_NOTES: [RegExp, string][] = [
	[
		/not accepted by the token overlay/i,
		"Some token outputs weren't accepted by the token overlay and stayed put.",
	],
	[
		/: skipped \S+ \(/,
		"Some source transactions couldn't be fetched, so those items stayed put.",
	],
	[
		/key could not be read/i,
		"An old key couldn't be read, so items at its address stayed put.",
	],
	[
		/not active on the overlay/i,
		"Tokens not validated on the overlay were skipped.",
	],
];

/** The plain reason behind each sweep error, deduplicated. */
export function outcomeNotes(errors: string[]): string[] {
	const notes = new Set<string>();
	for (const error of errors) {
		const known = OUTCOME_NOTES.find(([pattern]) => pattern.test(error));
		notes.add(known ? known[1] : "Some transactions failed. See Details.");
	}
	return [...notes];
}

/**
 * Per-class outcome. With the sweep's final steps, each step is one row;
 * without them the result's txids say which classes moved.
 */
export function summarizeOutcome(
	result: SweepResult | null,
	remaining: number,
	steps: SweepProgress["steps"] = [],
): SweepOutcome {
	const base = { remaining, notes: [] as string[], errorCount: 0 };
	if (!result) {
		return {
			...base,
			kind: "nothing",
			headline:
				remaining > 0
					? `${plural(remaining, "item")} to move`
					: "Nothing to sweep",
			rows: [],
		};
	}
	const rows: OutcomeRow[] = [];
	if (steps.length > 0) {
		for (const step of steps) {
			const status: OutcomeStatus =
				step.status === "done"
					? "done"
					: step.txids.length > 0
						? "partial"
						: "failed";
			rows.push({
				key: step.id,
				label: rowLabel(step),
				status,
				note:
					status === "done"
						? "Moved"
						: status === "partial"
							? "Partly moved"
							: step.status === "pending"
								? "Not started"
								: "Not moved",
			});
		}
	} else {
		const classes: [string, string, string[]][] = [
			["bsv", "BSV", result.bsvTxids],
			["ordinals", "Ordinals & names", result.ordinalTxids],
			["bsv21", "Tokens", result.bsv21Txids],
			["bsv20", "BSV-20 tokens", result.bsv20Txids],
		];
		for (const [key, label, txids] of classes) {
			if (txids.length > 0)
				rows.push({ key, label, status: "done", note: "Moved" });
		}
	}
	const cancelled = cancelledListingCount(result);
	if (cancelled > 0) {
		rows.push({
			key: "listings",
			label: "Listings",
			status: "done",
			note: `${plural(cancelled, "listing")} cancelled`,
		});
	}
	if ((result.transferTxids?.length ?? 0) > 0) {
		rows.push({
			key: "transfer",
			label: "This wallet's assets",
			status: "done",
			note: "Moved to your identity key",
		});
	}
	const errorCount = result.errors.length;
	const outcome = {
		remaining,
		rows,
		errorCount,
		notes: outcomeNotes(result.errors),
	};
	if (errorCount > 0 && !rows.some((r) => r.status !== "failed")) {
		return { ...outcome, kind: "failed", headline: "Nothing was moved" };
	}
	if (errorCount > 0 || remaining > 0) {
		return {
			...outcome,
			kind: "moved-with-left",
			headline:
				remaining > 0
					? `Moved, ${remaining.toLocaleString("en-US")} left`
					: "Moved, with some problems",
		};
	}
	if (rows.length === 0) {
		return { ...outcome, kind: "nothing", headline: "Nothing to sweep" };
	}
	return { ...outcome, kind: "all-moved", headline: "All moved" };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const KNOWN_ERRORS: [RegExp, string][] = [
	[
		/listing.*(cancel|could not)|cancel.*listing/i,
		"Some listings couldn't be cancelled.",
	],
	[
		/Failed to re-encrypt wallet/i,
		"Couldn't save your wallet. Unlock it again and retry.",
	],
	[
		/missing pay or ord key/i,
		"This wallet is missing a legacy key, so it can't be swept.",
	],
	[/Unlock your wallet/i, "Unlock your wallet to continue."],
	[
		/failed to fetch|network ?error|ECONNRESET|timed? ?out/i,
		"Network problem. Check your connection and try again.",
	],
	[/insufficient (funds|fee)/i, "Not enough BSV to pay the network fee."],
];

const SHORT_MAX = 140;

/**
 * A short, specific message for the screen. The full text belongs in the
 * console and the Details sheet; the caller keeps it there.
 */
export function shortError(raw: string): string {
	const text = raw.trim();
	if (!text) return "Something went wrong.";
	for (const [pattern, message] of KNOWN_ERRORS) {
		if (pattern.test(text)) return message;
	}
	const first = text.split(/(?<=[.!?])\s+/)[0] ?? text;
	return first.length > SHORT_MAX
		? `${first.slice(0, SHORT_MAX - 1).trimEnd()}…`
		: first;
}
