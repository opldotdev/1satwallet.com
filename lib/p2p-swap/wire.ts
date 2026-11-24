/**
 * What the trade window sends through the relay to settle a locked trade in
 * one transaction (docs/p2p-settlement-protocol.md). Shared by the browser and
 * Convex, so it uses no browser or wallet APIs. The relay is untrusted: these
 * parsers bound sizes and shapes, and each wallet still checks the candidate
 * transaction itself before it signs.
 */
import type { P2PTradeItem } from "../types/p2p";

export type SwapSide = "initiator" | "participant";

export const SWAP_MAX_INPUTS = 64;
export const SWAP_MAX_TX_HEX = 200_000;
export const SWAP_MAX_UNLOCK_HEX = 1_000;
export const SWAP_MAX_REASON = 200;

const OUTPOINT = /^[0-9a-f]{64}_(0|[1-9][0-9]*)$/;
const TXID = /^[0-9a-f]{64}$/;
const HEX = /^(?:[0-9a-f]{2})+$/;
/** A plain pay-to-public-key-hash locking script. */
const P2PKH_SCRIPT = /^76a914[0-9a-f]{40}88ac$/;

export interface SwapScriptFor {
	/** The offered item this script receives or holds change for. */
	id: string;
	script: string;
}

/**
 * The non-builder's half: the outpoints it will sign, and where it receives
 * each of the builder's items and its own token change.
 */
export interface SwapContribution {
	initiatorRevision: number;
	participantRevision: number;
	inputs: string[];
	receive: {
		nft: SwapScriptFor[];
		token: SwapScriptFor[];
		change: SwapScriptFor[];
		satoshis: string | null;
	};
}

export interface SwapSignature {
	vin: number;
	unlockingScript: string;
}

export type SwapOutcome =
	| { kind: "txid"; txid: string }
	| { kind: "failed"; reason: string }
	| { kind: "unknown" };

export type SwapStep =
	| { step: "contribute"; contribution: SwapContribution }
	| { step: "candidate"; txHex: string }
	| { step: "signatures"; candidateHash: string; signatures: SwapSignature[] }
	| { step: "outcome"; outcome: SwapOutcome };

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Invalid ${label}`);
	}
	return value as Record<string, unknown>;
}

function only(value: Record<string, unknown>, fields: string[], label: string) {
	const extra = Object.keys(value).find((field) => !fields.includes(field));
	if (extra) throw new Error(`Invalid ${label} field: ${extra}`);
}

function revision(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		throw new Error("Invalid swap revision");
	}
	return value as number;
}

function outpoint(value: unknown): string {
	if (typeof value !== "string" || !OUTPOINT.test(value)) {
		throw new Error("Invalid swap outpoint");
	}
	return value;
}

function script(value: unknown): string {
	if (typeof value !== "string" || !P2PKH_SCRIPT.test(value)) {
		throw new Error("Invalid swap receive script");
	}
	return value;
}

function scriptsFor(value: unknown): SwapScriptFor[] {
	if (!Array.isArray(value) || value.length > 24) {
		throw new Error("Invalid swap receive list");
	}
	const seen = new Set<string>();
	return value.map((entry) => {
		const item = record(entry, "swap receive entry");
		only(item, ["id", "script"], "swap receive entry");
		const id = outpoint(item.id);
		if (seen.has(id)) throw new Error("Duplicate swap receive entry");
		seen.add(id);
		return { id, script: script(item.script) };
	});
}

export function parseSwapContribution(value: unknown): SwapContribution {
	const body = record(value, "swap contribution");
	only(
		body,
		["initiatorRevision", "participantRevision", "inputs", "receive"],
		"swap contribution",
	);
	if (!Array.isArray(body.inputs) || body.inputs.length > SWAP_MAX_INPUTS) {
		throw new Error("Invalid swap inputs");
	}
	const inputs = body.inputs.map(outpoint);
	if (new Set(inputs).size !== inputs.length) {
		throw new Error("Duplicate swap input");
	}
	const receive = record(body.receive, "swap receive");
	only(receive, ["nft", "token", "change", "satoshis"], "swap receive");
	return {
		initiatorRevision: revision(body.initiatorRevision),
		participantRevision: revision(body.participantRevision),
		inputs,
		receive: {
			nft: scriptsFor(receive.nft),
			token: scriptsFor(receive.token),
			change: scriptsFor(receive.change),
			satoshis: receive.satoshis === null ? null : script(receive.satoshis),
		},
	};
}

export function parseSwapTxHex(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length > SWAP_MAX_TX_HEX ||
		!HEX.test(value)
	) {
		throw new Error("Invalid swap transaction");
	}
	return value;
}

export function parseSwapSignatures(value: unknown): SwapSignature[] {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.length > SWAP_MAX_INPUTS
	) {
		throw new Error("Invalid swap signatures");
	}
	const seen = new Set<number>();
	return value.map((entry) => {
		const item = record(entry, "swap signature");
		only(item, ["vin", "unlockingScript"], "swap signature");
		const vin = item.vin;
		if (
			!Number.isSafeInteger(vin) ||
			(vin as number) < 0 ||
			seen.has(vin as number)
		) {
			throw new Error("Invalid swap signature input");
		}
		seen.add(vin as number);
		const unlockingScript = item.unlockingScript;
		if (
			typeof unlockingScript !== "string" ||
			unlockingScript.length > SWAP_MAX_UNLOCK_HEX ||
			!HEX.test(unlockingScript)
		) {
			throw new Error("Invalid swap unlocking script");
		}
		return { vin: vin as number, unlockingScript };
	});
}

export function parseSwapOutcome(value: unknown): SwapOutcome {
	const body = record(value, "swap outcome");
	if (body.kind === "txid") {
		only(body, ["kind", "txid"], "swap outcome");
		if (typeof body.txid !== "string" || !TXID.test(body.txid)) {
			throw new Error("Invalid swap txid");
		}
		return { kind: "txid", txid: body.txid };
	}
	if (body.kind === "failed") {
		only(body, ["kind", "reason"], "swap outcome");
		if (
			typeof body.reason !== "string" ||
			!body.reason ||
			body.reason.length > SWAP_MAX_REASON
		) {
			throw new Error("Invalid swap failure reason");
		}
		return { kind: "failed", reason: body.reason };
	}
	if (body.kind === "unknown") {
		only(body, ["kind"], "swap outcome");
		return { kind: "unknown" };
	}
	throw new Error("Invalid swap outcome");
}

export function parseSwapStep(value: unknown): SwapStep {
	const body = record(value, "swap step");
	switch (body.step) {
		case "contribute":
			return {
				step: "contribute",
				contribution: parseSwapContribution(body.contribution),
			};
		case "candidate":
			return { step: "candidate", txHex: parseSwapTxHex(body.txHex) };
		case "signatures": {
			if (
				typeof body.candidateHash !== "string" ||
				!TXID.test(body.candidateHash)
			) {
				throw new Error("Invalid swap candidate hash");
			}
			return {
				step: "signatures",
				candidateHash: body.candidateHash,
				signatures: parseSwapSignatures(body.signatures),
			};
		}
		case "outcome":
			return { step: "outcome", outcome: parseSwapOutcome(body.outcome) };
		default:
			throw new Error("Invalid swap step");
	}
}

/** Total satoshis a side offers. */
export function offeredSatoshis(items: readonly P2PTradeItem[]): number {
	let total = 0;
	for (const item of items) {
		if (item.type === "satoshis") total += item.satoshis;
	}
	return total;
}

export type SwapTermsError = "empty-offer" | "gifts-off" | "both-offer-bsv";

export interface SwapTerms {
	initiatorItems: readonly P2PTradeItem[];
	participantItems: readonly P2PTradeItem[];
	/** Each side's own "Allow giving gifts" setting, off by default. */
	initiatorAllowsGift?: boolean;
	participantAllowsGift?: boolean;
}

/**
 * Who builds and funds the swap transaction. In a gift, the giver builds; else
 * the side paying BSV; else the side that opened the trade. A one-sided trade
 * needs the giver's "Allow giving gifts" on, and only one side may pay BSV.
 */
export function swapBuilder(
	terms: SwapTerms,
):
	| { ok: true; builder: SwapSide; gift: boolean }
	| { ok: false; error: SwapTermsError } {
	const initiatorGives = terms.initiatorItems.length > 0;
	const participantGives = terms.participantItems.length > 0;
	if (!initiatorGives && !participantGives) {
		return { ok: false, error: "empty-offer" };
	}
	if (!initiatorGives || !participantGives) {
		const giver: SwapSide = initiatorGives ? "initiator" : "participant";
		const allowed =
			giver === "initiator"
				? terms.initiatorAllowsGift
				: terms.participantAllowsGift;
		if (!allowed) return { ok: false, error: "gifts-off" };
		return { ok: true, builder: giver, gift: true };
	}
	const initiatorPays = offeredSatoshis(terms.initiatorItems) > 0;
	const participantPays = offeredSatoshis(terms.participantItems) > 0;
	if (initiatorPays && participantPays) {
		return { ok: false, error: "both-offer-bsv" };
	}
	return {
		ok: true,
		builder: participantPays ? "participant" : "initiator",
		gift: false,
	};
}

export const SWAP_TERMS_MESSAGE: Record<SwapTermsError, string> = {
	"empty-offer": "Add something to an offer before the swap.",
	"gifts-off":
		"One side is offering nothing. The giver can turn on Allow giving gifts to send it as a gift.",
	"both-offer-bsv":
		"Only one of you can offer BSV. Remove BSV from one offer to swap.",
};

function ids(items: readonly P2PTradeItem[], type: P2PTradeItem["type"]) {
	return items
		.filter((item) => item.type === type)
		.map((item) => item.id)
		.sort();
}

function sameIds(entries: readonly SwapScriptFor[], expected: string[]) {
	const actual = entries.map((entry) => entry.id).sort();
	return (
		actual.length === expected.length &&
		actual.every((id, index) => id === expected[index])
	);
}

/**
 * Checks a contribution covers the agreed terms: the non-builder signs every
 * ordinal it offered and gives one receive script per builder item, one change
 * script per token it offers, and a BSV script exactly when the builder pays
 * BSV. Token tips are checked by the builder's wallet against the overlay.
 */
export function contributionMatchesTerms(
	contribution: SwapContribution,
	builderItems: readonly P2PTradeItem[],
	contributorItems: readonly P2PTradeItem[],
): boolean {
	const inputs = new Set(contribution.inputs);
	const contributorOrdinals = ids(contributorItems, "ordinal");
	if (!contributorOrdinals.every((id) => inputs.has(id))) return false;
	const hasTokens = contributorItems.some((item) => item.type === "bsv21");
	const tokenTips = inputs.size - contributorOrdinals.length;
	if (hasTokens ? tokenTips < 1 : tokenTips !== 0) return false;
	const { receive } = contribution;
	return (
		sameIds(receive.nft, ids(builderItems, "ordinal")) &&
		sameIds(receive.token, ids(builderItems, "bsv21")) &&
		sameIds(receive.change, ids(contributorItems, "bsv21")) &&
		(receive.satoshis !== null) === offeredSatoshis(builderItems) > 0
	);
}
