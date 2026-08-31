import type { Bsv21Balance } from "@1sat/actions";
import { getOrdinalThumbnail } from "./image-utils";
import type { P2PBsv21TradeItem } from "./types/p2p";
import { formatBsv21Amount, parseBsv21Amount } from "./wallet/bsv21-actions";

const CANONICAL_TOKEN_ID = /^[0-9a-f]{64}_(0|[1-9][0-9]*)$/;
const CANONICAL_ATOMIC_BALANCE = /^(?:0|[1-9][0-9]*)$/;
const OUTPOINT = /^[0-9a-fA-F]{64}[._](0|[1-9][0-9]*)$/;

export interface Bsv21OfferToken {
	id: string;
	name: string;
	symbol: string;
	decimals: number;
	balanceAtomic: string;
	balanceDisplay: string;
	image?: string;
}

export type Bsv21OfferItemResult =
	| { ok: true; item: P2PBsv21TradeItem }
	| { ok: false; error: string };

function safeSymbol(symbol: string | undefined): string | null {
	if (!symbol) return null;
	const normalized = symbol.trim().replace(/\s+/g, " ").slice(0, 64);
	return normalized || null;
}

function canonicalIconOutpoint(tokenId: string, icon: string): string | null {
	const normalized = icon.trim();
	if (/^_(0|[1-9][0-9]*)$/.test(normalized)) {
		return `${tokenId.slice(0, 64)}${normalized}`;
	}
	if (!OUTPOINT.test(normalized)) return null;
	return normalized.replace(".", "_").toLowerCase();
}

function trustedIconUrl(icon: string): string | null {
	try {
		const url = new URL(icon);
		if (url.protocol !== "https:" || url.port || url.username || url.password) {
			return null;
		}
		if (
			url.hostname === "api.1sat.app" &&
			url.pathname.startsWith("/content/")
		) {
			return url.toString();
		}
		if (url.hostname === "ordfs.network") return url.toString();
		if (url.hostname === "themetoken.dev" && url.pathname.startsWith("/og/")) {
			return url.toString();
		}
		return null;
	} catch {
		return null;
	}
}

export function getSafeBsv21OfferImage(
	tokenId: string,
	icon: string | undefined,
): string | undefined {
	if (!icon) return undefined;
	const outpoint = canonicalIconOutpoint(tokenId, icon);
	if (outpoint) return getOrdinalThumbnail(outpoint, 200);
	return trustedIconUrl(icon) ?? undefined;
}

export function toBsv21OfferToken(token: Bsv21Balance): Bsv21OfferToken | null {
	const id = token.id.replace(".", "_").toLowerCase();
	if (!CANONICAL_TOKEN_ID.test(id)) return null;
	if (
		!Number.isInteger(token.dec) ||
		token.dec < 0 ||
		token.dec > 18 ||
		token.amt.length > 80 ||
		!CANONICAL_ATOMIC_BALANCE.test(token.amt) ||
		BigInt(token.amt) === 0n
	) {
		return null;
	}
	const symbol = safeSymbol(token.sym) ?? `${id.slice(0, 8)}…`;
	const image = getSafeBsv21OfferImage(id, token.icon);
	return {
		id,
		name: symbol,
		symbol,
		decimals: token.dec,
		balanceAtomic: token.amt,
		balanceDisplay: formatBsv21Amount(token.amt, token.dec),
		...(image ? { image } : {}),
	};
}

export function createBsv21OfferItem(
	token: Bsv21OfferToken,
	displayAmount: string,
): Bsv21OfferItemResult {
	const atomicAmount = parseBsv21Amount(displayAmount, token.decimals);
	if (atomicAmount === null) {
		return {
			ok: false,
			error: `Enter a positive amount with at most ${token.decimals} decimals.`,
		};
	}
	const balance = BigInt(token.balanceAtomic);
	if (atomicAmount > balance) {
		return { ok: false, error: "Amount exceeds the available token balance." };
	}
	return {
		ok: true,
		item: {
			type: "bsv21",
			id: token.id,
			name: token.name,
			amount: atomicAmount.toString(),
			decimals: token.decimals,
			...(token.image ? { image: token.image } : {}),
		},
	};
}
