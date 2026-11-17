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
export const UNKNOWN_TICK = "Unknown";

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
}

/**
 * Group checked outputs by ticker, most outputs first; anything unreadable
 * or not BSV-20 goes in one "Unknown" bucket, always last.
 */
export function groupUnconfirmedBsv20(
	entries: { outpoint: string; content: Bsv20Content | null }[],
): Bsv20Group[] {
	const groups = new Map<string, Bsv20Group>();
	for (const { outpoint, content } of entries) {
		const tick = content?.tick ?? UNKNOWN_TICK;
		const key = content ? `t:${tick}` : "unknown";
		const group = groups.get(key) ?? { tick, outputs: 0, entries: [] };
		group.outputs++;
		group.entries.push({
			outpoint,
			op: content?.op ?? "",
			amt: content?.amt ?? null,
		});
		groups.set(key, group);
	}
	const unknown = groups.get("unknown");
	groups.delete("unknown");
	const sorted = [...groups.values()].sort(
		(a, b) => b.outputs - a.outputs || a.tick.localeCompare(b.tick),
	);
	return unknown ? [...sorted, unknown] : sorted;
}
