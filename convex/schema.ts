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
		result: v.string(),
		createdAt: v.number(),
		expiresAt: v.number(),
	})
		.index("by_identity_nonce", ["identityKey", "nonce"])
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
	})
		.index("by_requestId", ["requestId"])
		.index("by_to_status", ["toIdentity", "status"])
		.index("by_from_status", ["fromIdentity", "status"])
		.index("by_expiresAt", ["expiresAt"]),

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
	})
		.index("by_sessionId", ["sessionId"])
		.index("by_initiator", ["initiatorIdentity"])
		.index("by_participant", ["participantIdentity"])
		.index("by_expiresAt", ["expiresAt"]),

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
