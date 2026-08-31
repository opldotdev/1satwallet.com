import { Hash, Utils } from "@bsv/sdk";
import { v } from "convex/values";
import {
	isIdentityKey,
	type P2PAction,
	type P2PCommand,
	verifyP2PCommand,
} from "../lib/p2p-auth";
import type { P2PTradeItem } from "../lib/types/p2p";
import {
	internalMutation,
	type MutationCtx,
	mutation,
	type QueryCtx,
	query,
} from "./_generated/server";

const { toHex } = Utils;
const REQUEST_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const INBOX_TTL_MS = 12 * 60 * 60 * 1000;
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OUTPOINT = /^[0-9a-f]{64}_[0-9]+$/;

const signedArgs = { body: v.string(), signature: v.string() };

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid signed command payload");
	}
	return value as Record<string, unknown>;
}

function stringField(
	value: Record<string, unknown>,
	field: string,
	limit = 256,
): string {
	const result = value[field];
	if (typeof result !== "string" || !result || result.length > limit) {
		throw new Error(`Invalid ${field}`);
	}
	return result;
}

function uuidField(value: Record<string, unknown>, field: string): string {
	const result = stringField(value, field, 64).toLowerCase();
	if (!UUID.test(result)) throw new Error(`Invalid ${field}`);
	return result;
}

function identityField(value: Record<string, unknown>, field: string): string {
	const result = stringField(value, field).toLowerCase();
	if (!isIdentityKey(result)) throw new Error(`Invalid ${field}`);
	return result;
}

function tokenHash(token: string): string {
	return toHex(Hash.sha256(token, "utf8"));
}

function parseItems(value: unknown): P2PTradeItem[] {
	if (!Array.isArray(value) || value.length > 24) {
		throw new Error("Invalid offer items");
	}
	return value.map((candidate) => {
		const item = record(candidate);
		const id = stringField(item, "id", 128).toLowerCase();
		const name = stringField(item, "name", 140);
		const type = item.type;
		if (type !== "ordinal" && type !== "bsv21" && type !== "satoshis") {
			throw new Error("Invalid offer item type");
		}
		const image = item.image;
		if (
			image !== undefined &&
			(typeof image !== "string" || image.length > 2048)
		) {
			throw new Error("Invalid offer item image");
		}
		const amount = item.amount;
		if (
			amount !== undefined &&
			(typeof amount !== "string" || amount.length > 80)
		) {
			throw new Error("Invalid offer item amount");
		}
		const result: P2PTradeItem = { id, name, type, image, amount };
		if (type === "ordinal") {
			if (!OUTPOINT.test(id)) throw new Error("Invalid ordinal outpoint");
			const [txid, voutText] = id.split("_");
			const vout = Number(voutText);
			if (!Number.isSafeInteger(vout) || vout < 0) {
				throw new Error("Invalid ordinal outpoint");
			}
			result.txid = txid;
			result.vout = vout;
		}
		if (
			item.satoshis !== undefined &&
			(!Number.isSafeInteger(item.satoshis) || (item.satoshis as number) < 0)
		) {
			throw new Error("Invalid item satoshis");
		}
		if (typeof item.satoshis === "number") result.satoshis = item.satoshis;
		return result;
	});
}

async function runIdempotent<T>(
	ctx: MutationCtx,
	action: P2PAction,
	body: string,
	signature: string,
	execute: (command: P2PCommand, now: number) => Promise<T>,
): Promise<T> {
	const now = Date.now();
	const command = verifyP2PCommand({ body, signature }, action, now);
	const bodyHash = toHex(Hash.sha256(body, "utf8"));
	const previous = await ctx.db
		.query("p2pCommands")
		.withIndex("by_identity_nonce", (q) =>
			q.eq("identityKey", command.identityKey).eq("nonce", command.nonce),
		)
		.first();
	if (previous) {
		if (previous.action !== action || previous.bodyHash !== bodyHash) {
			throw new Error("Signed command nonce was already used");
		}
		return JSON.parse(previous.result) as T;
	}
	const result = await execute(command, now);
	await ctx.db.insert("p2pCommands", {
		identityKey: command.identityKey,
		nonce: command.nonce,
		action,
		bodyHash,
		result: JSON.stringify(result ?? null),
		createdAt: now,
		expiresAt: Math.max(command.expiresAt, now + SESSION_TTL_MS),
	});
	return result;
}

async function requestById(ctx: MutationCtx, requestId: string) {
	return ctx.db
		.query("p2pRequests")
		.withIndex("by_requestId", (q) => q.eq("requestId", requestId))
		.first();
}

async function sessionById(ctx: MutationCtx, sessionId: string) {
	return ctx.db
		.query("p2pSessions")
		.withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
		.first();
}

export const openInbox = mutation({
	args: signedArgs,
	handler: async (ctx, args) =>
		runIdempotent(
			ctx,
			"inbox.open",
			args.body,
			args.signature,
			async (command, now) => {
				const payload = record(command.payload);
				const token = uuidField(payload, "token");
				const hash = tokenHash(token);
				const previous = await ctx.db
					.query("p2pInboxTokens")
					.withIndex("by_tokenHash", (q) => q.eq("tokenHash", hash))
					.first();
				if (previous && previous.identityKey !== command.identityKey) {
					throw new Error(
						"Inbox capability already belongs to another identity",
					);
				}
				const expiresAt = now + INBOX_TTL_MS;
				if (previous) await ctx.db.patch(previous._id, { expiresAt });
				else {
					await ctx.db.insert("p2pInboxTokens", {
						identityKey: command.identityKey,
						tokenHash: hash,
						expiresAt,
						createdAt: now,
					});
				}
				return { expiresAt };
			},
		),
});

export const sendRequest = mutation({
	args: signedArgs,
	handler: async (ctx, args) =>
		runIdempotent(
			ctx,
			"request.create",
			args.body,
			args.signature,
			async (command, now) => {
				const payload = record(command.payload);
				const requestId = uuidField(payload, "requestId");
				const toIdentity = identityField(payload, "toIdentity");
				if (toIdentity === command.identityKey)
					throw new Error("Cannot trade with yourself");
				const requestedExpiry = now + REQUEST_TTL_MS;
				const pendingFromIdentity = await ctx.db
					.query("p2pRequests")
					.withIndex("by_from_status", (q) =>
						q.eq("fromIdentity", command.identityKey).eq("status", "pending"),
					)
					.take(6);
				const samePeer = pendingFromIdentity.find(
					(request) =>
						request.toIdentity === toIdentity && request.expiresAt > now,
				);
				if (samePeer) {
					return {
						requestId: samePeer.requestId,
						expiresAt: samePeer.expiresAt,
						alreadyExists: true,
					};
				}
				if (
					pendingFromIdentity.filter((request) => request.expiresAt > now)
						.length >= 5
				) {
					throw new Error("Too many pending trade requests");
				}
				const existing = await requestById(ctx, requestId);
				if (existing) throw new Error("Trade request already exists");
				await ctx.db.insert("p2pRequests", {
					requestId,
					fromIdentity: command.identityKey,
					toIdentity,
					status: "pending",
					expiresAt: requestedExpiry,
					createdAt: now,
					updatedAt: now,
				});
				return { requestId, expiresAt: requestedExpiry };
			},
		),
});

export const acceptRequest = mutation({
	args: signedArgs,
	handler: async (ctx, args) =>
		runIdempotent(
			ctx,
			"request.accept",
			args.body,
			args.signature,
			async (command, now) => {
				const payload = record(command.payload);
				const requestId = uuidField(payload, "requestId");
				const sessionId = uuidField(payload, "sessionId");
				const request = await requestById(ctx, requestId);
				if (!request || request.toIdentity !== command.identityKey) {
					throw new Error("Trade request not found");
				}
				if (request.status === "accepted" && request.sessionId) {
					return { sessionId: request.sessionId };
				}
				if (request.status !== "pending")
					throw new Error("Trade request is no longer pending");
				if (request.expiresAt <= now) {
					await ctx.db.patch(request._id, {
						status: "expired",
						updatedAt: now,
					});
					throw new Error("Trade request expired");
				}
				if (await sessionById(ctx, sessionId))
					throw new Error("Trade session already exists");
				const expiresAt = now + SESSION_TTL_MS;
				await ctx.db.insert("p2pSessions", {
					sessionId,
					initiatorIdentity: request.fromIdentity,
					participantIdentity: request.toIdentity,
					initiatorItems: [],
					participantItems: [],
					initiatorRevision: 0,
					participantRevision: 0,
					initiatorLocked: false,
					participantLocked: false,
					status: "negotiating",
					expiresAt,
					createdAt: now,
					updatedAt: now,
				});
				await ctx.db.patch(request._id, {
					status: "accepted",
					sessionId,
					updatedAt: now,
				});
				return { sessionId };
			},
		),
});

async function closeRequest(
	ctx: MutationCtx,
	action: "request.decline" | "request.cancel",
	body: string,
	signature: string,
) {
	return runIdempotent(ctx, action, body, signature, async (command, now) => {
		const requestId = uuidField(record(command.payload), "requestId");
		const request = await requestById(ctx, requestId);
		if (!request) throw new Error("Trade request not found");
		const nextStatus = action === "request.decline" ? "declined" : "cancelled";
		const authorized =
			action === "request.decline"
				? request.toIdentity === command.identityKey
				: request.fromIdentity === command.identityKey;
		if (!authorized) throw new Error("Not authorized for this trade request");
		if (request.status === nextStatus) return { requestId };
		if (request.status !== "pending")
			throw new Error("Trade request is no longer pending");
		await ctx.db.patch(request._id, { status: nextStatus, updatedAt: now });
		return { requestId };
	});
}

export const declineRequest = mutation({
	args: signedArgs,
	handler: (ctx, args) =>
		closeRequest(ctx, "request.decline", args.body, args.signature),
});

export const cancelRequest = mutation({
	args: signedArgs,
	handler: (ctx, args) =>
		closeRequest(ctx, "request.cancel", args.body, args.signature),
});

export const updateOffer = mutation({
	args: signedArgs,
	handler: async (ctx, args) =>
		runIdempotent(
			ctx,
			"session.offer",
			args.body,
			args.signature,
			async (command, now) => {
				const payload = record(command.payload);
				const sessionId = uuidField(payload, "sessionId");
				const revision = payload.revision;
				const locked = payload.locked;
				if (
					!Number.isSafeInteger(revision) ||
					(revision as number) < 1 ||
					typeof locked !== "boolean"
				) {
					throw new Error("Invalid offer revision");
				}
				const items = parseItems(payload.items);
				const session = await sessionById(ctx, sessionId);
				if (!session) throw new Error("Trade session not found");
				if (session.status === "cancelled" || session.status === "expired") {
					throw new Error("Trade session is closed");
				}
				if (session.expiresAt <= now) {
					await ctx.db.patch(session._id, {
						status: "expired",
						updatedAt: now,
					});
					throw new Error("Trade session expired");
				}
				const initiator = session.initiatorIdentity === command.identityKey;
				const participant = session.participantIdentity === command.identityKey;
				if (!initiator && !participant)
					throw new Error("Not authorized for this trade session");
				const currentRevision = initiator
					? session.initiatorRevision
					: session.participantRevision;
				if (revision !== currentRevision + 1)
					throw new Error("Offer changed; refresh and try again");
				const peerLocked = initiator
					? session.participantLocked
					: session.initiatorLocked;
				const status = locked && peerLocked ? "ready" : "negotiating";
				await ctx.db.patch(
					session._id,
					initiator
						? {
								initiatorItems: items,
								initiatorRevision: revision as number,
								initiatorLocked: locked,
								participantLocked: locked ? session.participantLocked : false,
								status,
								updatedAt: now,
							}
						: {
								participantItems: items,
								participantRevision: revision as number,
								participantLocked: locked,
								initiatorLocked: locked ? session.initiatorLocked : false,
								status,
								updatedAt: now,
							},
				);
				return { sessionId, revision };
			},
		),
});

export const cancelSession = mutation({
	args: signedArgs,
	handler: async (ctx, args) =>
		runIdempotent(
			ctx,
			"session.cancel",
			args.body,
			args.signature,
			async (command, now) => {
				const sessionId = uuidField(record(command.payload), "sessionId");
				const session = await sessionById(ctx, sessionId);
				if (!session) throw new Error("Trade session not found");
				if (
					session.initiatorIdentity !== command.identityKey &&
					session.participantIdentity !== command.identityKey
				) {
					throw new Error("Not authorized for this trade session");
				}
				if (session.status !== "cancelled") {
					await ctx.db.patch(session._id, {
						status: "cancelled",
						updatedAt: now,
					});
				}
				return { sessionId };
			},
		),
});

async function inboxIdentity(ctx: QueryCtx, token: string) {
	if (!UUID.test(token)) return null;
	const capability = await ctx.db
		.query("p2pInboxTokens")
		.withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash(token)))
		.first();
	return capability && capability.expiresAt > Date.now()
		? capability.identityKey
		: null;
}

export const inbox = query({
	args: { token: v.string() },
	handler: async (ctx, { token }) => {
		const identityKey = await inboxIdentity(ctx, token);
		if (!identityKey) {
			return { incoming: [], outgoingPending: [], outgoingAccepted: [] };
		}
		const [incoming, outgoingPending, accepted] = await Promise.all([
			ctx.db
				.query("p2pRequests")
				.withIndex("by_to_status", (q) =>
					q.eq("toIdentity", identityKey).eq("status", "pending"),
				)
				.order("desc")
				.take(20),
			ctx.db
				.query("p2pRequests")
				.withIndex("by_from_status", (q) =>
					q.eq("fromIdentity", identityKey).eq("status", "pending"),
				)
				.order("desc")
				.take(20),
			ctx.db
				.query("p2pRequests")
				.withIndex("by_from_status", (q) =>
					q.eq("fromIdentity", identityKey).eq("status", "accepted"),
				)
				.order("desc")
				.take(20),
		]);
		const now = Date.now();
		const sessionLookups = [];
		for (const request of accepted) {
			if (request.sessionId) {
				sessionLookups.push(
					(async () => ({
						request,
						session: await ctx.db
							.query("p2pSessions")
							.withIndex("by_sessionId", (q) =>
								q.eq("sessionId", request.sessionId as string),
							)
							.first(),
					}))(),
				);
			}
		}
		const acceptedSessions = await Promise.all(sessionLookups);
		const outgoingAccepted: typeof accepted = [];
		for (const { request, session } of acceptedSessions) {
			if (
				session &&
				session.expiresAt > now &&
				(session.status === "negotiating" || session.status === "ready")
			) {
				outgoingAccepted.push(request);
			}
		}
		return {
			incoming: incoming.filter((request) => request.expiresAt > now),
			outgoingPending: outgoingPending.filter(
				(request) => request.expiresAt > now,
			),
			outgoingAccepted,
		};
	},
});

export const getSession = query({
	args: { sessionId: v.string() },
	handler: async (ctx, { sessionId }) => {
		if (!UUID.test(sessionId)) return null;
		return ctx.db
			.query("p2pSessions")
			.withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
			.first();
	},
});

export const deleteExpiredRecords = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const [inboxTokens, commands, requests, sessions] = await Promise.all([
			ctx.db
				.query("p2pInboxTokens")
				.withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
				.take(200),
			ctx.db
				.query("p2pCommands")
				.withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
				.take(200),
			ctx.db
				.query("p2pRequests")
				.withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
				.take(200),
			ctx.db
				.query("p2pSessions")
				.withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
				.take(200),
		]);
		const requestExpirations = [];
		for (const request of requests) {
			if (request.status === "pending") {
				requestExpirations.push(
					ctx.db.patch(request._id, { status: "expired", updatedAt: now }),
				);
			}
		}
		const sessionExpirations = [];
		for (const session of sessions) {
			if (session.status === "negotiating" || session.status === "ready") {
				sessionExpirations.push(
					ctx.db.patch(session._id, { status: "expired", updatedAt: now }),
				);
			}
		}
		await Promise.all([
			...inboxTokens.map((item) => ctx.db.delete(item._id)),
			...commands.map((item) => ctx.db.delete(item._id)),
			...requestExpirations,
			...sessionExpirations,
		]);
	},
});
