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

const swapScriptFor = v.object({ id: v.string(), script: v.string() });

// One swap attempt for a ready session (docs/p2p-settlement-protocol.md).
// Holds only public transaction data: never an action reference or a key.
const p2pSettlement = v.object({
	builder: v.union(v.literal("initiator"), v.literal("participant")),
	initiatorRevision: v.number(),
	participantRevision: v.number(),
	contribution: v.object({
		initiatorRevision: v.number(),
		participantRevision: v.number(),
		inputs: v.array(v.string()),
		receive: v.object({
			nft: v.array(swapScriptFor),
			token: v.array(swapScriptFor),
			change: v.array(swapScriptFor),
			satoshis: v.union(v.string(), v.null()),
		}),
	}),
	candidate: v.optional(
		v.object({ txHex: v.string(), hash: v.string(), postedAt: v.number() }),
	),
	signatures: v.optional(
		v.object({
			candidateHash: v.string(),
			entries: v.array(
				v.object({ vin: v.number(), unlockingScript: v.string() }),
			),
		}),
	),
	outcome: v.optional(
		v.union(
			v.object({ kind: v.literal("txid"), txid: v.string() }),
			v.object({ kind: v.literal("failed"), reason: v.string() }),
			v.object({ kind: v.literal("unknown") }),
		),
	),
	startedAt: v.number(),
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
		result: v.string(),
		createdAt: v.number(),
		expiresAt: v.number(),
	})
		.index("by_identity_nonce", ["identityKey", "nonce"])
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

	// The presence room's read token, kept server-side so only the floor
	// query uses it. The component hands the same token to every heartbeat
	// and never rotates it, so clients get nothing from it.
	p2pFloorRooms: defineTable({
		roomId: v.literal("landing"),
		roomToken: v.string(),
	}).index("by_roomId", ["roomId"]),

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
		initiatorAllowsGift: v.optional(v.boolean()),
		participantAllowsGift: v.optional(v.boolean()),
		status: v.union(
			v.literal("negotiating"),
			v.literal("ready"),
			v.literal("settling"),
			v.literal("settled"),
			v.literal("cancelled"),
			v.literal("expired"),
		),
		settlement: v.optional(p2pSettlement),
		lastSettlementError: v.optional(v.string()),
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
