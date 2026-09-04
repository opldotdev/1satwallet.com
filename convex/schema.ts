import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const p2pTradeItem = v.union(
	v.object({
		id: v.string(),
		name: v.string(),
		type: v.literal("ordinal"),
		image: v.optional(v.string()),
		txid: v.string(),
		vout: v.number(),
		satoshis: v.optional(v.number()),
	}),
	v.object({
		id: v.string(),
		name: v.string(),
		type: v.literal("bsv21"),
		amount: v.string(),
		decimals: v.optional(v.number()),
		image: v.optional(v.string()),
	}),
	v.object({
		id: v.string(),
		name: v.string(),
		type: v.literal("satoshis"),
		image: v.optional(v.string()),
		satoshis: v.number(),
	}),
);

const settlementStatus = v.union(
	v.literal("preparing"),
	v.literal("contributing"),
	v.literal("constructing"),
	v.literal("reviewing"),
	v.literal("partially_authorized"),
	v.literal("authorized"),
	v.literal("broadcasting"),
	v.literal("verifying"),
	v.literal("overlay_pending"),
	v.literal("internalizing"),
	v.literal("outcome_unknown"),
	v.literal("settled"),
	v.literal("conflicted"),
	v.literal("expired"),
	v.literal("cancelled"),
	v.literal("failed"),
);

const settlementPrepare = v.object({
	walletIdentity: v.string(),
	providerInstanceId: v.string(),
	prepareHash: v.string(),
});

const settlementContribution = v.object({
	contributionHash: v.string(),
	reservationId: v.string(),
	reservationExpiresAt: v.number(),
});

const settlementAuthorization = v.object({
	authorizationHash: v.string(),
	contributionHash: v.string(),
	authorizationExpiresAt: v.number(),
});

const settlementInternalization = v.object({
	status: v.union(v.literal("complete"), v.literal("failed")),
	checkedAt: v.number(),
	receiptHash: v.optional(v.string()),
});

export default defineSchema({
	p2pInboxTokens: defineTable({
		identityKey: v.string(),
		tokenHash: v.string(),
		expiresAt: v.number(),
		createdAt: v.number(),
	})
		.index("by_tokenHash", ["tokenHash"])
		.index("by_expiresAt", ["expiresAt"]),

	p2pCommands: defineTable({
		identityKey: v.string(),
		nonce: v.string(),
		action: v.string(),
		bodyHash: v.string(),
		signatureHash: v.optional(v.string()),
		result: v.string(),
		createdAt: v.number(),
		expiresAt: v.number(),
		settlementId: v.optional(v.string()),
		settlementAttempt: v.optional(v.number()),
	})
		.index("by_identity_nonce", ["identityKey", "nonce"])
		.index("by_settlement_attempt", ["settlementId", "settlementAttempt"])
		.index("by_expiresAt", ["expiresAt"]),

	p2pPresenceAnnouncements: defineTable({
		roomId: v.literal("landing"),
		userId: v.string(),
		identityKey: v.string(),
		chain: v.union(v.literal("main"), v.literal("test")),
		sessionId: v.string(),
		profile: v.optional(
			v.object({
				displayName: v.optional(v.string()),
				avatarUrl: v.optional(v.string()),
				source: v.union(
					v.literal("bap"),
					v.literal("certificate"),
					v.literal("profile"),
				),
				sourceReference: v.optional(v.string()),
			}),
		),
		profileVerification: v.optional(v.literal("unverified")),
		issuedAt: v.number(),
		expiresAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_userId", ["userId"])
		.index("by_expiresAt", ["expiresAt"]),

	p2pRequests: defineTable({
		requestId: v.string(),
		fromIdentity: v.string(),
		toIdentity: v.string(),
		status: v.union(
			v.literal("pending"),
			v.literal("accepted"),
			v.literal("declined"),
			v.literal("cancelled"),
			v.literal("expired"),
		),
		sessionId: v.optional(v.string()),
		expiresAt: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
		terminalAt: v.optional(v.number()),
		purgeAt: v.optional(v.number()),
	})
		.index("by_requestId", ["requestId"])
		.index("by_to_status", ["toIdentity", "status"])
		.index("by_from_status", ["fromIdentity", "status"])
		.index("by_status_expiresAt", ["status", "expiresAt"])
		.index("by_expiresAt", ["expiresAt"])
		.index("by_purgeAt", ["purgeAt"]),

	p2pSessions: defineTable({
		sessionId: v.string(),
		initiatorIdentity: v.string(),
		participantIdentity: v.string(),
		initiatorItems: v.array(p2pTradeItem),
		participantItems: v.array(p2pTradeItem),
		initiatorRevision: v.number(),
		participantRevision: v.number(),
		initiatorLocked: v.boolean(),
		participantLocked: v.boolean(),
		status: v.union(
			v.literal("negotiating"),
			v.literal("ready"),
			v.literal("cancelled"),
			v.literal("expired"),
		),
		expiresAt: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
		terminalAt: v.optional(v.number()),
		purgeAt: v.optional(v.number()),
	})
		.index("by_sessionId", ["sessionId"])
		.index("by_initiator", ["initiatorIdentity"])
		.index("by_participant", ["participantIdentity"])
		.index("by_status_expiresAt", ["status", "expiresAt"])
		.index("by_expiresAt", ["expiresAt"])
		.index("by_purgeAt", ["purgeAt"]),

	p2pSettlements: defineTable({
		protocol: v.literal("1sat-p2p-settlement"),
		wireVersion: v.literal(1),
		chain: v.union(v.literal("main"), v.literal("test")),
		sessionId: v.string(),
		settlementId: v.string(),
		attempt: v.number(),
		offerDigest: v.string(),
		lockedInitiatorRevision: v.number(),
		lockedParticipantRevision: v.number(),
		partyA: v.string(),
		partyB: v.string(),
		builder: v.string(),
		feePayer: v.string(),
		status: settlementStatus,
		stateVersion: v.number(),
		lastPartyARevision: v.number(),
		lastPartyBRevision: v.number(),
		lastVerifierRevision: v.number(),
		partyAPrepare: v.optional(settlementPrepare),
		partyBPrepare: v.optional(settlementPrepare),
		partyAContribution: v.optional(settlementContribution),
		partyBContribution: v.optional(settlementContribution),
		templateHash: v.optional(v.string()),
		manifestHash: v.optional(v.string()),
		signableBeefHash: v.optional(v.string()),
		overlayTokenIds: v.optional(v.array(v.string())),
		partyAInputIndexes: v.optional(v.array(v.number())),
		partyBInputIndexes: v.optional(v.array(v.number())),
		partyAAuthorization: v.optional(settlementAuthorization),
		partyBAuthorization: v.optional(settlementAuthorization),
		broadcastLease: v.optional(
			v.object({
				leaseId: v.string(),
				leaseExpiresAt: v.number(),
				broadcaster: v.string(),
			}),
		),
		rawTxHash: v.optional(v.string()),
		txid: v.optional(v.string()),
		broadcastEvidenceHash: v.optional(v.string()),
		providerResult: v.optional(
			v.union(
				v.literal("accepted"),
				v.literal("already-known"),
				v.literal("unknown"),
				v.literal("rejected"),
			),
		),
		chainEvidenceHash: v.optional(v.string()),
		overlayEvidence: v.optional(
			v.array(
				v.object({
					tokenId: v.string(),
					status: v.union(
						v.literal("accepted"),
						v.literal("pending"),
						v.literal("rejected"),
					),
					checkedAt: v.number(),
					evidenceHash: v.string(),
				}),
			),
		),
		partyAInternalization: v.optional(settlementInternalization),
		partyBInternalization: v.optional(settlementInternalization),
		failureHash: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
		expiresAt: v.number(),
		terminalAt: v.optional(v.number()),
		purgeAt: v.optional(v.number()),
	})
		.index("by_settlement_attempt", ["settlementId", "attempt"])
		.index("by_settlement", ["settlementId"])
		.index("by_session", ["sessionId"])
		.index("by_status_expiresAt", ["status", "expiresAt"])
		.index("by_purgeAt", ["purgeAt"]),

	// CWI redirect fallback auth requests (OAuth-style)
	cwiAuthRequests: defineTable({
		requestId: v.string(),
		origin: v.string(),
		redirectUri: v.string(),
		call: v.string(),
		args: v.any(),
		argsHash: v.string(),
		state: v.string(),
		nonce: v.string(),
		codeChallenge: v.string(),
		codeChallengeMethod: v.literal("S256"),
		status: v.union(
			v.literal("pending"),
			v.literal("approved"),
			v.literal("denied"),
			v.literal("error"),
			v.literal("exchanged"),
			v.literal("expired"),
		),
		error: v.optional(v.string()),
		errorDescription: v.optional(v.string()),
		errorCode: v.optional(v.number()),
		errorStack: v.optional(v.string()),
		expiresAt: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_requestId", ["requestId"])
		.index("by_expiresAt", ["expiresAt"])
		.index("by_status", ["status"]),

	// CWI one-time auth codes for token exchange
	cwiAuthCodes: defineTable({
		codeId: v.string(),
		requestId: v.string(),
		origin: v.string(),
		redirectUri: v.string(),
		resultCiphertext: v.optional(v.string()),
		error: v.optional(v.string()),
		errorDescription: v.optional(v.string()),
		consumedAt: v.optional(v.number()),
		expiresAt: v.number(),
		createdAt: v.number(),
	})
		.index("by_codeId", ["codeId"])
		.index("by_requestId", ["requestId"])
		.index("by_expiresAt", ["expiresAt"]),
});
