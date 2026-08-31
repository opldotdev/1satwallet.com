import { Hash, Utils } from "@bsv/sdk";
import { Presence } from "@convex-dev/presence";
import { v } from "convex/values";
import {
	authenticatePresenceAnnouncement,
	isActiveWalletPresence,
	PRESENCE_ROOM_ID,
	publicPresenceIdentity,
} from "../lib/p2p-presence";
import { components } from "./_generated/api";
import {
	internalMutation,
	type MutationCtx,
	mutation,
	query,
} from "./_generated/server";

const { toHex } = Utils;
const ROOM_ID = PRESENCE_ROOM_ID;
const HEARTBEAT_INTERVAL = 10_000;
const WALLET_USER_ID =
	/^wallet:(main|test):(02|03)[0-9a-f]{64}:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ANONYMOUS_USER_ID =
	/^anon:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const presence = new Presence(components.presence);
const signedArgs = { body: v.string(), signature: v.string() };

function assertVisualPresenceInput(roomId: string, userId: string) {
	if (
		roomId !== ROOM_ID ||
		userId.length > 256 ||
		(!WALLET_USER_ID.test(userId) && !ANONYMOUS_USER_ID.test(userId))
	) {
		throw new Error("Invalid visual presence identity");
	}
}

async function requireActiveWalletAnnouncement(
	ctx: MutationCtx,
	userId: string,
	now = Date.now(),
) {
	if (!WALLET_USER_ID.test(userId)) return;
	const announcement = await ctx.db
		.query("p2pPresenceAnnouncements")
		.withIndex("by_userId", (q) => q.eq("userId", userId))
		.unique();
	if (!isActiveWalletPresence(userId, announcement, now)) {
		throw new Error("Connected presence requires a current wallet signature");
	}
}

export const announce = mutation({
	args: signedArgs,
	handler: async (ctx, signed) => {
		const now = Date.now();
		const announcement = await authenticatePresenceAnnouncement(
			signed,
			async (candidate) => {
				const previous = await ctx.db
					.query("p2pCommands")
					.withIndex("by_identity_nonce", (q) =>
						q
							.eq("identityKey", candidate.identityKey)
							.eq("nonce", candidate.nonce),
					)
					.first();
				if (previous) return false;
				await ctx.db.insert("p2pCommands", {
					identityKey: candidate.identityKey,
					nonce: candidate.nonce,
					action: "presence.announce",
					bodyHash: toHex(Hash.sha256(signed.body, "utf8")),
					result: JSON.stringify({ userId: candidate.payload.userId }),
					createdAt: now,
					expiresAt: candidate.expiresAt,
				});
				return true;
			},
			now,
		);
		const existing = await ctx.db
			.query("p2pPresenceAnnouncements")
			.withIndex("by_userId", (q) =>
				q.eq("userId", announcement.payload.userId),
			)
			.unique();
		const record = {
			roomId: ROOM_ID as "landing",
			userId: announcement.payload.userId,
			identityKey: announcement.identityKey,
			chain: announcement.payload.chain,
			sessionId: announcement.payload.sessionId,
			...(announcement.payload.publicProfile
				? {
						profile: announcement.payload.publicProfile,
						profileVerification: "unverified" as const,
					}
				: {}),
			issuedAt: announcement.issuedAt,
			expiresAt: announcement.expiresAt,
			updatedAt: now,
		};
		if (existing) await ctx.db.patch(existing._id, record);
		else await ctx.db.insert("p2pPresenceAnnouncements", record);
		return publicPresenceIdentity(announcement);
	},
});

export const listPublicIdentities = query({
	args: { roomId: v.string() },
	handler: async (ctx, { roomId }) => {
		if (roomId !== ROOM_ID) throw new Error("Invalid presence room");
		const now = Date.now();
		const announcements = await ctx.db
			.query("p2pPresenceAnnouncements")
			.withIndex("by_expiresAt", (q) => q.gt("expiresAt", now))
			.take(104);
		return announcements.map((announcement) => ({
			userId: announcement.userId,
			identityKey: announcement.identityKey,
			chain: announcement.chain,
			label: `${announcement.identityKey.slice(0, 6)}…${announcement.identityKey.slice(-4)}`,
			verification: "wallet-signature" as const,
			expiresAt: announcement.expiresAt,
			...(announcement.profile
				? {
						profile: {
							...announcement.profile,
							verification: announcement.profileVerification ?? "unverified",
						},
					}
				: {}),
		}));
	},
});

export const deleteExpiredAnnouncements = internalMutation({
	args: {},
	handler: async (ctx) => {
		const expired = await ctx.db
			.query("p2pPresenceAnnouncements")
			.withIndex("by_expiresAt", (q) => q.lt("expiresAt", Date.now()))
			.take(200);
		for (const announcement of expired) await ctx.db.delete(announcement._id);
		return expired.length;
	},
});

export const heartbeat = mutation({
	args: {
		roomId: v.string(),
		userId: v.string(),
		sessionId: v.string(),
		interval: v.number(),
	},
	handler: async (ctx, { roomId, userId, sessionId }) => {
		assertVisualPresenceInput(roomId, userId);
		if (!sessionId || sessionId.length > 512) {
			throw new Error("Invalid visual presence session");
		}
		await requireActiveWalletAnnouncement(ctx, userId);
		return await presence.heartbeat(
			ctx,
			roomId,
			userId,
			sessionId,
			HEARTBEAT_INTERVAL,
		);
	},
});

export const list = query({
	args: { roomToken: v.string() },
	handler: async (ctx, { roomToken }) => {
		if (!roomToken || roomToken.length > 512) {
			throw new Error("Invalid presence token");
		}
		return await presence.list(ctx, roomToken);
	},
});

export const disconnect = mutation({
	args: { sessionToken: v.string() },
	handler: async (ctx, { sessionToken }) => {
		if (!sessionToken || sessionToken.length > 512) {
			throw new Error("Invalid presence token");
		}
		return await presence.disconnect(ctx, sessionToken);
	},
});

// Presence is deliberately visual-only. A userId is never proof of wallet
// ownership and must not authorize wallet, trade, or account operations.
export const updateCursor = mutation({
	args: {
		roomId: v.string(),
		userId: v.string(),
		data: v.object({ x: v.number(), y: v.number() }),
	},
	handler: async (ctx, { roomId, userId, data }) => {
		assertVisualPresenceInput(roomId, userId);
		await requireActiveWalletAnnouncement(ctx, userId);
		if (
			!Number.isFinite(data.x) ||
			!Number.isFinite(data.y) ||
			data.x < 0 ||
			data.x > 100 ||
			data.y < 0 ||
			data.y > 100
		) {
			throw new Error("Invalid cursor position");
		}
		return await presence.updateRoomUser(ctx, roomId, userId, data);
	},
});
