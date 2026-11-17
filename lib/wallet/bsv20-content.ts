/**
 * Display-only reading of BSV-20 inscription content, for the "stays where
 * it is" step. The indexer this wallet uses doesn't track BSV-20, so these
 * values are what the inscription claims, unverified. They are labels for
 * the screen and never feed the scan, the plan or the sweep.
 */

export interface Bsv20Content {
	/** Uppercased for grouping. */
	tick: string;
	op: string;
	/** The claimed amount as written, digits only; null when absent or odd. */
	amt: string | null;
}

export const BSV20_CONTENT_MAX_BYTES = 2048;
const MAX_TICK_LENGTH = 32;
/** The group for outputs whose content couldn't be read as BSV-20. */
export const UNREADABLE_TICK = "Unreadable";

/**
 * Content types worth reading as BSV-20. The content server serves BSV-20
 * inscriptions as application/bsv-20 (checked 2026-11-17: api.1sat.app
 * /content/<txid>_<vout> for a ZOID mint answers content-type
 * application/bsv-20); some are inscribed as JSON or plain text. A missing
 * header is read too, since the body decides.
 */
export function isBsv20ContentType(contentType: string | null): boolean {
	if (!contentType) return true;
	const type = contentType.split(";")[0].trim().toLowerCase();
	return (
		type === "application/bsv-20" ||
		/(^|[/+])json$/.test(type) ||
		type === "text/plain"
	);
}

/** Why an output's content couldn't be read as BSV-20, in plain words. */
export const BSV20_UNREADABLE = {
	notBsv20: "its content isn't a BSV-20 inscription",
	tooLarge: "its content is larger than any BSV-20 inscription",
	contentType: (type: string) => `its content is ${type}, not BSV-20`,
	http: (status: number) => `the content server answered HTTP ${status}`,
	timeout: "the content server didn't answer in time",
	network: "the content server couldn't be reached",
} as const;

/** What reading one output's content gave: its BSV-20 fields, or why not. */
export type Bsv20Read =
	| { content: Bsv20Content; reason?: undefined }
	| { content: null; reason: string };

/** A `{"p":"bsv-20",...}` inscription, or null for anything else. */
export function parseBsv20Content(text: string): Bsv20Content | null {
	if (text.length > BSV20_CONTENT_MAX_BYTES) return null;
	const trimmed = text.trim();
	if (!trimmed.startsWith("{")) return null;
	let json: unknown;
	try {
		json = JSON.parse(trimmed);
	} catch {
		// Not JSON: an image, HTML or plain text inscription.
		return null;
	}
	if (!json || typeof json !== "object" || Array.isArray(json)) return null;
	const record = json as Record<string, unknown>;
	if (record.p !== "bsv-20") return null;
	if (typeof record.tick !== "string") return null;
	const tick = record.tick.trim().toUpperCase();
	if (!tick || tick.length > MAX_TICK_LENGTH) return null;
	const op =
		typeof record.op === "string" ? record.op.trim().toLowerCase() : "";
	const amt =
		typeof record.amt === "string" && /^\d{1,40}(\.\d{1,18})?$/.test(record.amt)
			? record.amt
			: null;
	return { tick, op, amt };
}

export interface Bsv20Group {
	tick: string;
	outputs: number;
	/** Each output with what its inscription claims; Details only. */
	entries: { outpoint: string; op: string; amt: string | null }[];
	/** Unreadable group only: why, with how many outputs each. */
	reasons?: { reason: string; outputs: number }[];
}

/**
 * Group checked outputs by ticker, most outputs first; anything that couldn't
 * be read as BSV-20 goes in one "Unreadable" group with its reasons, last.
 */
export function groupUnconfirmedBsv20(
	entries: { outpoint: string; read: Bsv20Read }[],
): Bsv20Group[] {
	const groups = new Map<string, Bsv20Group>();
	const reasons = new Map<string, number>();
	for (const { outpoint, read } of entries) {
		const { content } = read;
		const tick = content?.tick ?? UNREADABLE_TICK;
		const key = content ? `t:${tick}` : "unreadable";
		const group = groups.get(key) ?? { tick, outputs: 0, entries: [] };
		group.outputs++;
		group.entries.push({
			outpoint,
			op: content?.op ?? "",
			amt: content?.amt ?? null,
		});
		groups.set(key, group);
		if (!content) reasons.set(read.reason, (reasons.get(read.reason) ?? 0) + 1);
	}
	const unreadable = groups.get("unreadable");
	groups.delete("unreadable");
	const sorted = [...groups.values()].sort(
		(a, b) => b.outputs - a.outputs || a.tick.localeCompare(b.tick),
	);
	if (!unreadable) return sorted;
	unreadable.reasons = [...reasons]
		.map(([reason, outputs]) => ({ reason, outputs }))
		.sort((a, b) => b.outputs - a.outputs || a.reason.localeCompare(b.reason));
	return [...sorted, unreadable];
}
