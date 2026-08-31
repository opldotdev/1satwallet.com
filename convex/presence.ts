import { Presence } from "@convex-dev/presence";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";

const ROOM_ID = "landing";
const HEARTBEAT_INTERVAL = 10_000;
const WALLET_USER_ID = /^wallet:(main|test):(02|03)[0-9a-f]{64}$/;
const ANONYMOUS_USER_ID =
	/^anon:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const presence = new Presence(components.presence);

function assertVisualPresenceInput(roomId: string, userId: string) {
	if (
		roomId !== ROOM_ID ||
		userId.length > 256 ||
		(!WALLET_USER_ID.test(userId) && !ANONYMOUS_USER_ID.test(userId))
	) {
		throw new Error("Invalid visual presence identity");
	}
}

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
