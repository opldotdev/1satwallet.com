import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PrivateKey, ProtoWallet, type WalletInterface } from "@bsv/sdk";
import { signP2PCommand, verifyP2PCommand } from "../lib/p2p-auth";
import {
	assertParticipantBinding,
	assertSettlementState,
	buildLockedOfferCommitment,
	canonicalSettlementJson,
	type LockedSessionOffer,
	parsePositiveUint64,
	parseSettlementCommandPayload,
	type SettlementBinding,
	settlementDigest,
	settlementStatusAfterEvidence,
	settlementStatusAfterInternalization,
	settlementStatusAfterTimeout,
} from "../lib/p2p-settlement";

const PARTY_A = `02${"11".repeat(32)}`;
const PARTY_B = `03${"22".repeat(32)}`;
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SETTLEMENT_ID = "22222222-2222-4222-8222-222222222222";
const ORDINAL = `${"aa".repeat(32)}_0`;
const TOKEN_ID = `${"bb".repeat(32)}_1`;
const HASH = "cc".repeat(32);
const EXPIRES_AT = 2_000_000_000_000;

function lockedSession() {
	return {
		sessionId: SESSION_ID,
		initiatorIdentity: PARTY_B,
		participantIdentity: PARTY_A,
		initiatorItems: [
			{
				type: "bsv21" as const,
				id: TOKEN_ID,
				name: "Display data is not committed",
				image: "https://example.com/token.png",
				amount: "100",
			},
		],
		participantItems: [
			{
				type: "ordinal" as const,
				id: ORDINAL,
				name: "Ordinal display name",
				txid: "aa".repeat(32),
				vout: 0,
			},
		],
		initiatorRevision: 4,
		participantRevision: 7,
		initiatorLocked: true,
		participantLocked: true,
	};
}

function payload(overrides: Record<string, unknown> = {}) {
	return {
		protocol: "brc-178",
		version: 1,
		chain: "main",
		sessionId: SESSION_ID,
		settlementId: SETTLEMENT_ID,
		attempt: 1,
		offerDigest: HASH,
		lockedOfferVersion: {
			initiatorRevision: 4,
			participantRevision: 7,
		},
		builder: PARTY_A,
		feePayer: PARTY_A,
		sender: PARTY_A,
		recipient: PARTY_B,
		revision: 1,
		expiresAt: EXPIRES_AT,
		body: {},
		...overrides,
	};
}

function binding(): SettlementBinding {
	return {
		chain: "main",
		sessionId: SESSION_ID,
		settlementId: SETTLEMENT_ID,
		attempt: 1,
		offerDigest: HASH,
		lockedInitiatorRevision: 4,
		lockedParticipantRevision: 7,
		partyA: PARTY_A,
		partyB: PARTY_B,
		builder: PARTY_A,
		feePayer: PARTY_A,
		expiresAt: EXPIRES_AT,
		lastPartyARevision: 0,
		lastPartyBRevision: 3,
	};
}

describe("P2P settlement coordination commitments", () => {
	it("uses deterministic canonical JSON and a single SHA-256 commitment", () => {
		const value = { z: [3, { b: false, a: "x" }], a: 1 };
		const canonical = '{"a":1,"z":[3,{"a":"x","b":false}]}';
		assert.equal(canonicalSettlementJson(value), canonical);
		assert.equal(
			settlementDigest(value),
			createHash("sha256").update(canonical).digest("hex"),
		);
		assert.throws(
			() => canonicalSettlementJson({ value: undefined }),
			/Undefined/,
		);
		assert.throws(
			() => canonicalSettlementJson({ value: "\ud800" }),
			/Unicode/,
		);
	});

	it("binds the locked BSV21/ordinal offer while excluding presentation metadata", () => {
		const first = buildLockedOfferCommitment(
			lockedSession(),
			"main",
			PARTY_A,
			EXPIRES_AT,
		);
		const renamed = lockedSession();
		renamed.initiatorItems[0].name = "A different display name";
		renamed.initiatorItems[0].image = "https://example.com/other.png";
		const second = buildLockedOfferCommitment(
			renamed,
			"main",
			PARTY_A,
			EXPIRES_AT,
		);
		assert.deepEqual(first.parties, [PARTY_A, PARTY_B]);
		assert.equal(settlementDigest(first), settlementDigest(second));
		assert.deepEqual(first.offers[1].items, [
			{ kind: "bsv21", tokenId: TOKEN_ID, amount: "100" },
		]);
	});

	it("rejects BSV payment funding by the non-builder and uint64 overflow", () => {
		const invalid: LockedSessionOffer = {
			...lockedSession(),
			initiatorItems: [
				{
					type: "satoshis",
					id: "bsv-payment",
					name: "BSV",
					satoshis: 10,
				},
			],
		};
		assert.throws(
			() => buildLockedOfferCommitment(invalid, "main", PARTY_A, EXPIRES_AT),
			/non-builder/,
		);
		assert.equal(
			parsePositiveUint64("18446744073709551615", "amount"),
			"18446744073709551615",
		);
		assert.throws(
			() => parsePositiveUint64("18446744073709551616", "amount"),
			/Invalid amount/,
		);
	});
});

describe("P2P settlement signed binding and monotonic outcomes", () => {
	it("rejects substitution of any session, attempt, digest, role, expiry, or revision", () => {
		const parsed = parseSettlementCommandPayload(payload(), 1);
		assert.equal(
			assertParticipantBinding(parsed, binding(), PARTY_A),
			"partyA",
		);
		for (const changed of [
			{ sessionId: crypto.randomUUID() },
			{ settlementId: crypto.randomUUID() },
			{ attempt: 2 },
			{ offerDigest: "dd".repeat(32) },
			{ builder: PARTY_B, feePayer: PARTY_B },
			{ expiresAt: EXPIRES_AT + 1 },
			{ revision: 2 },
			{ recipient: PARTY_A },
		]) {
			assert.throws(() =>
				assertParticipantBinding(
					parseSettlementCommandPayload(payload(changed), 1),
					binding(),
					PARTY_A,
				),
			);
		}
		assert.throws(
			() => parseSettlementCommandPayload({ ...payload(), extra: true }, 1),
			/fields/,
		);
		assert.throws(
			() =>
				parseSettlementCommandPayload(
					payload({ offerDigest: HASH.toUpperCase() }),
					1,
				),
			/Invalid offerDigest/,
		);
	});

	it("never treats broadcast or overlay claims alone as settlement", () => {
		assert.equal(
			settlementStatusAfterEvidence("exact-tx", "found", ["accepted"]),
			"internalizing",
		);
		assert.equal(
			settlementStatusAfterEvidence("exact-tx", "found", ["pending"]),
			"overlay_pending",
		);
		assert.equal(
			settlementStatusAfterEvidence("exact-tx", "absent", ["accepted"]),
			"outcome_unknown",
		);
		assert.equal(
			settlementStatusAfterEvidence("conflicted", "absent", []),
			"conflicted",
		);
		assert.equal(
			settlementStatusAfterInternalization("complete", "failed"),
			"internalizing",
		);
		assert.equal(
			settlementStatusAfterInternalization("complete", "complete"),
			"settled",
		);
	});

	it("expires only pre-authorization and preserves recovery after an unlock", () => {
		for (const status of [
			"preparing",
			"contributing",
			"constructing",
			"reviewing",
		] as const) {
			assert.equal(settlementStatusAfterTimeout(status), "expired");
		}
		for (const status of [
			"partially_authorized",
			"authorized",
			"broadcasting",
			"verifying",
			"overlay_pending",
			"internalizing",
			"outcome_unknown",
		] as const) {
			assert.equal(settlementStatusAfterTimeout(status), "outcome_unknown");
		}
		assert.throws(() => settlementStatusAfterTimeout("settled"), /terminal/);
		assert.throws(
			() => assertSettlementState("cancelled", ["reviewing"]),
			/terminal/,
		);
	});

	it("BRC-77 signs the whole coordination body and detects byte substitution", async () => {
		const wallet = new ProtoWallet(PrivateKey.fromRandom()) as WalletInterface;
		const identityKey = (
			await wallet.getPublicKey({ identityKey: true })
		).publicKey.toLowerCase();
		const peer = identityKey === PARTY_A ? PARTY_B : PARTY_A;
		const signed = await signP2PCommand(wallet, "settlement.prepare", {
			...payload({ sender: identityKey, recipient: peer }),
			body: {
				walletIdentity: identityKey,
				providerInstanceId: crypto.randomUUID(),
				capabilities: {
					exactTemplateReview: true,
					externalInputSignature: true,
					localReservationLease: true,
					internalizeAction: true,
				},
			},
		});
		assert.equal(
			verifyP2PCommand(signed, "settlement.prepare").identityKey,
			identityKey,
		);
		const substituted = JSON.parse(signed.body) as {
			payload: { attempt: number };
		};
		substituted.payload.attempt = 2;
		assert.throws(
			() =>
				verifyP2PCommand(
					{ ...signed, body: JSON.stringify(substituted) },
					"settlement.prepare",
				),
			/signature/,
		);
	});
});

describe("Convex settlement persistence boundary", () => {
	it("stores hashes and evidence, not wallet signing material", () => {
		const schema = readFileSync(
			join(process.cwd(), "convex/schema.ts"),
			"utf8",
		);
		const coordinator = readFileSync(
			join(process.cwd(), "convex/settlement.ts"),
			"utf8",
		);
		assert.match(schema, /p2pSettlements/);
		assert.match(coordinator, /P2P_SETTLEMENT_VERIFIER_IDENTITY/);
		assert.match(coordinator, /settlement\.broadcast-claim/);
		assert.match(coordinator, /settlement\.evidence/);
		assert.match(coordinator, /Contribution hash does not match its contents/);
		assert.match(coordinator, /BSV21 contribution underfunds/);
		assert.match(coordinator, /Manifest does not conserve BSV21 quantities/);
		assert.match(coordinator, /partyAInputIndexes/);
		assert.match(coordinator, /signatureHash/);
		assert.match(coordinator, /Number\.MAX_SAFE_INTEGER/);
		for (const forbidden of [
			"privateKey",
			"mnemonic",
			"walletReference",
			"unlockingScript:",
			"rawBeef",
		]) {
			assert.equal(
				schema.includes(forbidden),
				false,
				`schema persisted forbidden settlement material: ${forbidden}`,
			);
		}
	});
});
