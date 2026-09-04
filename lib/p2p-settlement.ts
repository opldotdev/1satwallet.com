import { Hash, Utils } from "@bsv/sdk";
import type { P2PTradeItem } from "./types/p2p";

const { toArray, toHex } = Utils;

export const SETTLEMENT_PROTOCOL = "brc-178" as const;
export const SETTLEMENT_WIRE_VERSION = 1 as const;
export const SETTLEMENT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const MAX_SETTLEMENT_TTL_MS = 30 * 60 * 1000;

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTITY_KEY = /^(02|03)[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const OUTPOINT = /^[0-9a-f]{64}_(0|[1-9][0-9]*)$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const UINT64_MAX = 18_446_744_073_709_551_615n;

export type SettlementChain = "main" | "test";
export type SettlementStatus =
	| "preparing"
	| "contributing"
	| "constructing"
	| "reviewing"
	| "partially_authorized"
	| "authorized"
	| "broadcasting"
	| "verifying"
	| "overlay_pending"
	| "internalizing"
	| "outcome_unknown"
	| "settled"
	| "conflicted"
	| "expired"
	| "cancelled"
	| "failed";

export type SettlementAction =
	| "settlement.prepare"
	| "settlement.contribution"
	| "settlement.template"
	| "settlement.authorize"
	| "settlement.broadcast-claim"
	| "settlement.broadcast-result"
	| "settlement.evidence"
	| "settlement.internalize"
	| "settlement.cancel"
	| "settlement.timeout"
	| "settlement.failure";

export interface LockedOfferVersion {
	initiatorRevision: number;
	participantRevision: number;
}

export interface SettlementCommandPayload<T = unknown> {
	protocol: typeof SETTLEMENT_PROTOCOL;
	version: typeof SETTLEMENT_WIRE_VERSION;
	chain: SettlementChain;
	sessionId: string;
	settlementId: string;
	attempt: number;
	offerDigest: string;
	lockedOfferVersion: LockedOfferVersion;
	builder: string;
	feePayer: string;
	sender: string;
	recipient: string;
	revision: number;
	expiresAt: number;
	body: T;
}

export interface SettlementBinding {
	chain: SettlementChain;
	sessionId: string;
	settlementId: string;
	attempt: number;
	offerDigest: string;
	lockedInitiatorRevision: number;
	lockedParticipantRevision: number;
	partyA: string;
	partyB: string;
	builder: string;
	feePayer: string;
	expiresAt: number;
	lastPartyARevision: number;
	lastPartyBRevision: number;
}

export interface LockedSessionOffer {
	sessionId: string;
	initiatorIdentity: string;
	participantIdentity: string;
	initiatorItems: P2PTradeItem[];
	participantItems: P2PTradeItem[];
	initiatorRevision: number;
	participantRevision: number;
	initiatorLocked: boolean;
	participantLocked: boolean;
}

export interface LockedOfferCommitmentV1 {
	protocol: typeof SETTLEMENT_PROTOCOL;
	version: typeof SETTLEMENT_WIRE_VERSION;
	chain: SettlementChain;
	sessionId: string;
	parties: [string, string];
	offers: Array<{
		owner: string;
		revision: number;
		items: Array<
			| { kind: "ordinal"; outpoint: string }
			| { kind: "bsv21"; tokenId: string; amount: string }
			| { kind: "bsv"; satoshis: string }
		>;
	}>;
	builder: string;
	feePayer: string;
	expiresAt: number;
}

function object(value: unknown, message: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(message);
	}
	return value as Record<string, unknown>;
}

export function exactKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	message: string,
): void {
	const fields = new Set(allowed);
	if (Object.keys(value).some((key) => !fields.has(key))) {
		throw new Error(message);
	}
}

function boundedString(value: unknown, field: string, limit = 256): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > limit ||
		value.trim() !== value
	) {
		throw new Error(`Invalid ${field}`);
	}
	return value;
}

export function parseSettlementUuid(value: unknown, field: string): string {
	const raw = boundedString(value, field, 64);
	const result = raw.toLowerCase();
	if (raw !== result) throw new Error(`Invalid ${field}`);
	if (!UUID.test(result)) throw new Error(`Invalid ${field}`);
	return result;
}

export function parseSettlementIdentity(value: unknown, field: string): string {
	const raw = boundedString(value, field);
	const result = raw.toLowerCase();
	if (raw !== result) throw new Error(`Invalid ${field}`);
	if (!IDENTITY_KEY.test(result)) throw new Error(`Invalid ${field}`);
	return result;
}

export function parseSettlementHash(value: unknown, field: string): string {
	const raw = boundedString(value, field, 64);
	const result = raw.toLowerCase();
	if (raw !== result) throw new Error(`Invalid ${field}`);
	if (!HASH.test(result)) throw new Error(`Invalid ${field}`);
	return result;
}

export function parseSettlementOutpoint(value: unknown, field: string): string {
	const raw = boundedString(value, field, 80);
	const result = raw.toLowerCase();
	if (raw !== result) throw new Error(`Invalid ${field}`);
	if (!OUTPOINT.test(result)) throw new Error(`Invalid ${field}`);
	return result;
}

export function parsePositiveUint64(value: unknown, field: string): string {
	const result = boundedString(value, field, 20);
	if (!POSITIVE_DECIMAL.test(result) || BigInt(result) > UINT64_MAX) {
		throw new Error(`Invalid ${field}`);
	}
	return result;
}

export function parseNonNegativeDecimal(value: unknown, field: string): string {
	const result = boundedString(value, field, 24);
	if (!/^(0|[1-9][0-9]*)$/.test(result)) throw new Error(`Invalid ${field}`);
	return result;
}

export function parseSafeInteger(
	value: unknown,
	field: string,
	minimum = 0,
): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) {
		throw new Error(`Invalid ${field}`);
	}
	return value as number;
}

/** RFC 8785-compatible for the JSON-only settlement wire values we accept. */
export function canonicalSettlementJson(value: unknown): string {
	const assertUnicode = (text: string) => {
		for (let index = 0; index < text.length; index += 1) {
			const code = text.charCodeAt(index);
			if (code >= 0xd800 && code <= 0xdbff) {
				const next = text.charCodeAt(index + 1);
				if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) {
					throw new Error("Invalid Unicode in canonical JSON");
				}
				index += 1;
			} else if (code >= 0xdc00 && code <= 0xdfff) {
				throw new Error("Invalid Unicode in canonical JSON");
			}
		}
	};
	const visit = (item: unknown): unknown => {
		if (typeof item === "string") {
			assertUnicode(item);
			return item;
		}
		if (item === null || typeof item === "boolean") {
			return item;
		}
		if (typeof item === "number") {
			if (!Number.isFinite(item))
				throw new Error("Invalid canonical JSON number");
			return item;
		}
		if (Array.isArray(item)) return item.map(visit);
		if (item && typeof item === "object") {
			for (const key of Object.keys(item)) assertUnicode(key);
			return Object.fromEntries(
				Object.entries(item as Record<string, unknown>)
					.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
					.map(([key, nested]) => {
						if (nested === undefined) {
							throw new Error("Undefined is not valid canonical JSON");
						}
						return [key, visit(nested)];
					}),
			);
		}
		throw new Error("Invalid canonical JSON value");
	};
	return JSON.stringify(visit(value));
}

export function settlementDigest(value: unknown): string {
	return toHex(Hash.sha256(toArray(canonicalSettlementJson(value), "utf8")));
}

function committedItems(items: P2PTradeItem[]) {
	return items.map((item) => {
		switch (item.type) {
			case "ordinal":
				return {
					kind: "ordinal" as const,
					outpoint: parseSettlementOutpoint(item.id, "ordinal outpoint"),
				};
			case "bsv21":
				return {
					kind: "bsv21" as const,
					tokenId: parseSettlementOutpoint(item.id, "BSV21 token ID"),
					amount: parsePositiveUint64(item.amount, "BSV21 amount"),
				};
			case "satoshis":
				if (!Number.isSafeInteger(item.satoshis) || item.satoshis <= 0) {
					throw new Error("Invalid BSV amount");
				}
				return { kind: "bsv" as const, satoshis: String(item.satoshis) };
			default:
				throw new Error("Invalid locked offer item");
		}
	});
}

export function buildLockedOfferCommitment(
	session: LockedSessionOffer,
	chain: SettlementChain,
	builder: string,
	expiresAt: number,
): LockedOfferCommitmentV1 {
	if (!session.initiatorLocked || !session.participantLocked) {
		throw new Error("Both offers must be locked");
	}
	const initiator = parseSettlementIdentity(
		session.initiatorIdentity,
		"initiator identity",
	);
	const participant = parseSettlementIdentity(
		session.participantIdentity,
		"participant identity",
	);
	const canonicalBuilder = parseSettlementIdentity(builder, "builder");
	if (initiator === participant) {
		throw new Error("Settlement participants must be distinct");
	}
	const parties = [initiator, participant].sort() as [string, string];
	if (!parties.includes(canonicalBuilder)) {
		throw new Error("Builder is not a settlement participant");
	}
	const offers = [
		{
			owner: initiator,
			revision: parseSafeInteger(
				session.initiatorRevision,
				"initiator offer revision",
				1,
			),
			items: committedItems(session.initiatorItems),
		},
		{
			owner: participant,
			revision: parseSafeInteger(
				session.participantRevision,
				"participant offer revision",
				1,
			),
			items: committedItems(session.participantItems),
		},
	].sort((left, right) =>
		left.owner < right.owner ? -1 : left.owner > right.owner ? 1 : 0,
	);
	for (const offer of offers) {
		const seen = new Set<string>();
		for (const item of offer.items) {
			const key =
				item.kind === "ordinal"
					? `ordinal:${item.outpoint}`
					: item.kind === "bsv21"
						? `bsv21:${item.tokenId}`
						: "bsv";
			if (seen.has(key)) throw new Error("Duplicate locked offer asset");
			seen.add(key);
		}
		if (
			offer.owner !== canonicalBuilder &&
			offer.items.some((item) => item.kind === "bsv")
		) {
			throw new Error("The non-builder cannot fund a BSV payment in version 1");
		}
	}
	return {
		protocol: SETTLEMENT_PROTOCOL,
		version: SETTLEMENT_WIRE_VERSION,
		chain,
		sessionId: parseSettlementUuid(session.sessionId, "sessionId"),
		parties,
		offers,
		builder: canonicalBuilder,
		feePayer: canonicalBuilder,
		expiresAt: parseSafeInteger(expiresAt, "settlement expiry", 1),
	};
}

export function parseSettlementCommandPayload<T = unknown>(
	value: unknown,
	_now = Date.now(),
): SettlementCommandPayload<T> {
	const payload = object(value, "Invalid settlement command payload");
	exactKeys(
		payload,
		[
			"protocol",
			"version",
			"chain",
			"sessionId",
			"settlementId",
			"attempt",
			"offerDigest",
			"lockedOfferVersion",
			"builder",
			"feePayer",
			"sender",
			"recipient",
			"revision",
			"expiresAt",
			"body",
		],
		"Invalid settlement command fields",
	);
	if (
		payload.protocol !== SETTLEMENT_PROTOCOL ||
		payload.version !== SETTLEMENT_WIRE_VERSION ||
		(payload.chain !== "main" && payload.chain !== "test")
	) {
		throw new Error("Unsupported settlement protocol");
	}
	const version = object(
		payload.lockedOfferVersion,
		"Invalid locked offer version",
	);
	exactKeys(
		version,
		["initiatorRevision", "participantRevision"],
		"Invalid locked offer version fields",
	);
	const expiresAt = parseSafeInteger(payload.expiresAt, "settlement expiry", 1);
	const builder = parseSettlementIdentity(payload.builder, "builder");
	const feePayer = parseSettlementIdentity(payload.feePayer, "feePayer");
	if (builder !== feePayer) throw new Error("Builder must be the fee payer");
	return {
		protocol: SETTLEMENT_PROTOCOL,
		version: SETTLEMENT_WIRE_VERSION,
		chain: payload.chain,
		sessionId: parseSettlementUuid(payload.sessionId, "sessionId"),
		settlementId: parseSettlementUuid(payload.settlementId, "settlementId"),
		attempt: parseSafeInteger(payload.attempt, "settlement attempt", 1),
		offerDigest: parseSettlementHash(payload.offerDigest, "offerDigest"),
		lockedOfferVersion: {
			initiatorRevision: parseSafeInteger(
				version.initiatorRevision,
				"initiator offer revision",
				1,
			),
			participantRevision: parseSafeInteger(
				version.participantRevision,
				"participant offer revision",
				1,
			),
		},
		builder,
		feePayer,
		sender: parseSettlementIdentity(payload.sender, "sender"),
		recipient: parseSettlementIdentity(payload.recipient, "recipient"),
		revision: parseSafeInteger(payload.revision, "command revision", 1),
		expiresAt,
		body: payload.body as T,
	};
}

export function assertParticipantBinding(
	payload: SettlementCommandPayload,
	settlement: SettlementBinding,
	signer: string,
): "partyA" | "partyB" {
	const fieldsMatch =
		payload.chain === settlement.chain &&
		payload.sessionId === settlement.sessionId &&
		payload.settlementId === settlement.settlementId &&
		payload.attempt === settlement.attempt &&
		payload.offerDigest === settlement.offerDigest &&
		payload.lockedOfferVersion.initiatorRevision ===
			settlement.lockedInitiatorRevision &&
		payload.lockedOfferVersion.participantRevision ===
			settlement.lockedParticipantRevision &&
		payload.builder === settlement.builder &&
		payload.feePayer === settlement.feePayer &&
		payload.expiresAt === settlement.expiresAt;
	if (!fieldsMatch) throw new Error("Settlement binding does not match");
	const canonicalSigner = parseSettlementIdentity(signer, "command signer");
	if (payload.sender !== canonicalSigner) {
		throw new Error("Settlement sender does not match the BRC-77 signer");
	}
	const role =
		canonicalSigner === settlement.partyA
			? "partyA"
			: canonicalSigner === settlement.partyB
				? "partyB"
				: null;
	if (!role) throw new Error("Settlement signer is not a participant");
	const peer = role === "partyA" ? settlement.partyB : settlement.partyA;
	if (payload.recipient !== peer) {
		throw new Error("Settlement recipient is not the fixed counterparty");
	}
	const lastRevision =
		role === "partyA"
			? settlement.lastPartyARevision
			: settlement.lastPartyBRevision;
	if (payload.revision !== lastRevision + 1) {
		throw new Error("Settlement command revision is stale");
	}
	return role;
}

export function isSettlementTerminal(status: SettlementStatus): boolean {
	return ["settled", "conflicted", "expired", "cancelled", "failed"].includes(
		status,
	);
}

export function assertSettlementState(
	status: SettlementStatus,
	allowed: readonly SettlementStatus[],
): void {
	if (!allowed.includes(status)) {
		throw new Error(
			isSettlementTerminal(status)
				? "Settlement is already terminal"
				: `Settlement transition is not allowed from ${status}`,
		);
	}
}

export function settlementStatusAfterEvidence(
	inputStatus: "exact-tx" | "unspent" | "conflicted" | "unknown",
	chainStatus: "found" | "absent",
	overlayStatuses: readonly ("accepted" | "pending" | "rejected")[],
): SettlementStatus {
	if (inputStatus === "conflicted") return "conflicted";
	if (chainStatus !== "found" || inputStatus !== "exact-tx") {
		return "outcome_unknown";
	}
	return overlayStatuses.every((status) => status === "accepted")
		? "internalizing"
		: "overlay_pending";
}

export function settlementStatusAfterTimeout(
	status: SettlementStatus,
): "expired" | "outcome_unknown" {
	if (isSettlementTerminal(status)) {
		throw new Error("Settlement is already terminal");
	}
	if (
		[
			"partially_authorized",
			"authorized",
			"broadcasting",
			"verifying",
			"overlay_pending",
			"internalizing",
			"outcome_unknown",
		].includes(status)
	) {
		return "outcome_unknown";
	}
	if (
		["preparing", "contributing", "constructing", "reviewing"].includes(status)
	) {
		return "expired";
	}
	throw new Error("Settlement timeout cannot regress this state");
}

export function settlementStatusAfterInternalization(
	ownStatus: "complete" | "failed",
	peerStatus: "complete" | "failed" | undefined,
): "internalizing" | "settled" {
	return ownStatus === "complete" && peerStatus === "complete"
		? "settled"
		: "internalizing";
}

export function bodyRecord(
	value: unknown,
	allowed: readonly string[],
	message: string,
): Record<string, unknown> {
	const result = object(value, message);
	exactKeys(result, allowed, `${message} fields`);
	return result;
}
