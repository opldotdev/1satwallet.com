import type {
	P2PBsv21TradeItem,
	P2POrdinalTradeItem,
	P2PSatoshisTradeItem,
	P2PTradeItem,
} from "./types/p2p";

const MAX_ITEMS = 24;
const MAX_AMOUNT_DIGITS = 80;
const CANONICAL_OUTPOINT = /^([0-9a-f]{64})_(0|[1-9][0-9]*)$/;
const POSITIVE_ATOMIC_AMOUNT = /^[1-9][0-9]*$/;

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid offer item");
	}
	return value as Record<string, unknown>;
}

function requiredDisplayString(
	item: Record<string, unknown>,
	field: "name",
	limit: number,
): string {
	const value = item[field];
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > limit ||
		value.trim() !== value
	) {
		throw new Error(`Invalid offer item ${field}`);
	}
	return value;
}

function optionalImage(item: Record<string, unknown>): string | undefined {
	const value = item.image;
	if (value === undefined) return undefined;
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 2048 ||
		value.trim() !== value
	) {
		throw new Error("Invalid offer item image");
	}
	return value;
}

function onlyFields(
	item: Record<string, unknown>,
	allowed: readonly string[],
): void {
	const allowedFields = new Set(allowed);
	const unexpected = Object.keys(item).find(
		(field) => !allowedFields.has(field),
	);
	if (unexpected) throw new Error(`Invalid offer item field: ${unexpected}`);
}

function canonicalOutpoint(
	value: unknown,
	label: "ordinal outpoint" | "BSV21 token id",
): { id: string; txid: string; vout: number } {
	if (typeof value !== "string") throw new Error(`Invalid ${label}`);
	const match = CANONICAL_OUTPOINT.exec(value);
	if (!match) throw new Error(`Invalid ${label}`);
	const vout = Number(match[2]);
	if (!Number.isSafeInteger(vout)) throw new Error(`Invalid ${label}`);
	return { id: value, txid: match[1], vout };
}

function optionalSatoshis(item: Record<string, unknown>): number | undefined {
	const value = item.satoshis;
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error("Invalid offer item satoshis");
	}
	return value as number;
}

function parseOrdinal(item: Record<string, unknown>): P2POrdinalTradeItem {
	onlyFields(item, ["type", "id", "name", "image", "txid", "vout", "satoshis"]);
	const outpoint = canonicalOutpoint(item.id, "ordinal outpoint");
	if (item.txid !== outpoint.txid || item.vout !== outpoint.vout) {
		throw new Error("Ordinal outpoint fields do not match");
	}
	const result: P2POrdinalTradeItem = {
		type: "ordinal",
		id: outpoint.id,
		name: requiredDisplayString(item, "name", 140),
		txid: outpoint.txid,
		vout: outpoint.vout,
	};
	const image = optionalImage(item);
	const satoshis = optionalSatoshis(item);
	if (image !== undefined) result.image = image;
	if (satoshis !== undefined) result.satoshis = satoshis;
	return result;
}

function parseBsv21(item: Record<string, unknown>): P2PBsv21TradeItem {
	// Tip outpoints and transaction fields are intentionally not negotiable.
	onlyFields(item, ["type", "id", "name", "image", "amount", "decimals"]);
	const { id } = canonicalOutpoint(item.id, "BSV21 token id");
	const amount = item.amount;
	if (
		typeof amount !== "string" ||
		amount.length > MAX_AMOUNT_DIGITS ||
		!POSITIVE_ATOMIC_AMOUNT.test(amount)
	) {
		throw new Error("Invalid BSV21 atomic amount");
	}
	const decimals = item.decimals;
	if (
		decimals !== undefined &&
		(typeof decimals !== "number" ||
			!Number.isInteger(decimals) ||
			decimals < 0 ||
			decimals > 18)
	) {
		throw new Error("Invalid BSV21 decimals");
	}
	const result: P2PBsv21TradeItem = {
		type: "bsv21",
		id,
		name: requiredDisplayString(item, "name", 140),
		amount,
	};
	const image = optionalImage(item);
	if (image !== undefined) result.image = image;
	if (typeof decimals === "number") result.decimals = decimals;
	return result;
}

function parseSatoshis(item: Record<string, unknown>): P2PSatoshisTradeItem {
	onlyFields(item, ["type", "id", "name", "image", "satoshis"]);
	if (
		typeof item.id !== "string" ||
		item.id.length === 0 ||
		item.id.length > 128 ||
		item.id.toLowerCase() !== item.id
	) {
		throw new Error("Invalid satoshis item id");
	}
	const satoshis = optionalSatoshis(item);
	if (satoshis === undefined || satoshis === 0) {
		throw new Error("Invalid offer item satoshis");
	}
	const result: P2PSatoshisTradeItem = {
		type: "satoshis",
		id: item.id,
		name: requiredDisplayString(item, "name", 140),
		satoshis,
	};
	const image = optionalImage(item);
	if (image !== undefined) result.image = image;
	return result;
}

export function parseP2PTradeItem(value: unknown): P2PTradeItem {
	const item = record(value);
	switch (item.type) {
		case "ordinal":
			return parseOrdinal(item);
		case "bsv21":
			return parseBsv21(item);
		case "satoshis":
			return parseSatoshis(item);
		default:
			throw new Error("Invalid offer item type");
	}
}

export function parseP2PTradeItems(value: unknown): P2PTradeItem[] {
	if (!Array.isArray(value) || value.length > MAX_ITEMS) {
		throw new Error("Invalid offer items");
	}
	const items = value.map(parseP2PTradeItem);
	const seen = new Set<string>();
	for (const item of items) {
		const key = `${item.type}:${item.id}`;
		if (seen.has(key)) throw new Error("Duplicate offer item");
		seen.add(key);
	}
	return items;
}
