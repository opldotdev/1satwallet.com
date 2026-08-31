import { Hash, Utils } from "@bsv/sdk";
import { v } from "convex/values";
import {
	isIdentityKey,
	type P2PAction,
	type P2PCommand,
	verifyP2PCommand,
} from "../lib/p2p-auth";
import { parseP2PTradeItems } from "../lib/p2p-trade-items";
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
// Terminal negotiations remain available for diagnostics and terminal-state
// observation for one day, then the cleanup cron removes them.
export const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

async function requestById(ctx: MutationCtx | QueryCtx, requestId: string) {
	return ctx.db
		.query("p2pRequests")
		.withIndex("by_requestId", (q) => q.eq("requestId", requestId))
		.first();
}

async function sessionById(ctx: MutationCtx | QueryCtx, sessionId: string) {
	return ctx.db
		.query("p2pSessions")
		.withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
		.first();
}

type RequestStatus =
	| "pending"
	| "accepted"
	| "declined"
	| "cancelled"
	| "expired";
type SessionStatus = "negotiating" | "ready" | "cancelled" | "expired";

function effectiveRequestStatus(
	request: { status: RequestStatus; expiresAt: number },
	now: number,
): RequestStatus {
	return request.status === "pending" && request.expiresAt <= now
		? "expired"
		: request.status;
}

function effectiveSessionStatus(
	session: { status: SessionStatus; expiresAt: number },
	now: number,
): SessionStatus {
	return (session.status === "negotiating" || session.status === "ready") &&
		session.expiresAt <= now
		? "expired"
		: session.status;
}

function sameItems(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
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
					.order("desc")
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
					purgeAt: requestedExpiry + TERMINAL_RETENTION_MS,
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
					const session = await sessionById(ctx, request.sessionId);
					const status = session
						? effectiveSessionStatus(session, now)
						: "expired";
					if (status === "cancelled" || status === "expired") {
						throw new Error("Trade session is closed");
					}
					return { sessionId: request.sessionId };
				}
				if (effectiveRequestStatus(request, now) === "expired") {
					throw new Error("Trade request expired");
				}
				if (request.status !== "pending")
					throw new Error("Trade request is no longer pending");
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
					purgeAt: expiresAt + TERMINAL_RETENTION_MS,
				});
				await ctx.db.patch(request._id, {
					status: "accepted",
					sessionId,
					updatedAt: now,
					terminalAt: now,
					purgeAt: now + TERMINAL_RETENTION_MS,
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
		if (effectiveRequestStatus(request, now) === "expired") {
			throw new Error("Trade request expired");
		}
		if (request.status !== "pending")
			throw new Error("Trade request is no longer pending");
		await ctx.db.patch(request._id, {
			status: nextStatus,
			updatedAt: now,
			terminalAt: now,
			purgeAt: now + TERMINAL_RETENTION_MS,
		});
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
				// The signature proves who authored the offer. These are negotiation
				// claims, not proof that Convex or the signer currently owns the assets.
				const items = parseP2PTradeItems(payload.items);
				const session = await sessionById(ctx, sessionId);
				if (!session) throw new Error("Trade session not found");
				const effectiveStatus = effectiveSessionStatus(session, now);
				if (effectiveStatus === "cancelled" || effectiveStatus === "expired") {
					throw new Error("Trade session is closed");
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
				const currentItems = initiator
					? session.initiatorItems
					: session.participantItems;
				const currentLocked = initiator
					? session.initiatorLocked
					: session.participantLocked;
				// A first lock of unchanged content may acknowledge the peer's lock.
				// Every other revision invalidates the peer's prior consent.
				const lockOnly =
					locked && !currentLocked && sameItems(currentItems, items);
				const nextPeerLocked = lockOnly ? peerLocked : false;
				const status = locked && nextPeerLocked ? "ready" : "negotiating";
				await ctx.db.patch(
					session._id,
					initiator
						? {
								initiatorItems: items,
								initiatorRevision: revision as number,
								initiatorLocked: locked,
								participantLocked: nextPeerLocked,
								status,
								updatedAt: now,
							}
						: {
								participantItems: items,
								participantRevision: revision as number,
								participantLocked: locked,
								initiatorLocked: nextPeerLocked,
								status,
								updatedAt: now,
							},
				);
				return { sessionId, revision, status };
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
				const status = effectiveSessionStatus(session, now);
				if (status === "expired") throw new Error("Trade session expired");
				if (status !== "cancelled") {
					await ctx.db.patch(session._id, {
						status: "cancelled",
						updatedAt: now,
						terminalAt: now,
						purgeAt: now + TERMINAL_RETENTION_MS,
					});
				}
				return { sessionId, status: "cancelled" as const };
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
			return {
				incoming: [],
				outgoingPending: [],
				outgoingAccepted: [],
				activeSessions: [],
			};
		}
		const [incoming, outgoingPending, accepted, initiated, participated] =
			await Promise.all([
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
				ctx.db
					.query("p2pSessions")
					.withIndex("by_initiator", (q) =>
						q.eq("initiatorIdentity", identityKey),
					)
					.order("desc")
					.take(20),
				ctx.db
					.query("p2pSessions")
					.withIndex("by_participant", (q) =>
						q.eq("participantIdentity", identityKey),
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
			const status = session ? effectiveSessionStatus(session, now) : "expired";
			if (status === "negotiating" || status === "ready") {
				outgoingAccepted.push(request);
			}
		}
		const activeSessions = [...initiated, ...participated]
			.filter((session) => {
				const status = effectiveSessionStatus(session, now);
				return status === "negotiating" || status === "ready";
			})
			.sort((left, right) => right.updatedAt - left.updatedAt)
			.slice(0, 20);
		return {
			incoming: incoming.filter(
				(request) => effectiveRequestStatus(request, now) === "pending",
			),
			outgoingPending: outgoingPending.filter(
				(request) => effectiveRequestStatus(request, now) === "pending",
			),
			outgoingAccepted,
			activeSessions,
		};
	},
});

export const getSession = query({
	args: { sessionId: v.string() },
	handler: async (ctx, { sessionId }) => {
		if (!UUID.test(sessionId)) return null;
		const session = await sessionById(ctx, sessionId);
		if (!session) return null;
		const status = effectiveSessionStatus(session, Date.now());
		return status === session.status ? session : { ...session, status };
	},
});

export const deleteExpiredRecords = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const [
			inboxTokens,
			commands,
			pendingRequests,
			negotiatingSessions,
			readySessions,
			legacyRequests,
			legacySessions,
			requestPurges,
			sessionPurges,
		] = await Promise.all([
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
				.withIndex("by_status_expiresAt", (q) =>
					q.eq("status", "pending").lt("expiresAt", now),
				)
				.take(200),
			ctx.db
				.query("p2pSessions")
				.withIndex("by_status_expiresAt", (q) =>
					q.eq("status", "negotiating").lt("expiresAt", now),
				)
				.take(200),
			ctx.db
				.query("p2pSessions")
				.withIndex("by_status_expiresAt", (q) =>
					q.eq("status", "ready").lt("expiresAt", now),
				)
				.take(200),
			ctx.db
				.query("p2pRequests")
				.withIndex("by_purgeAt", (q) => q.eq("purgeAt", undefined))
				.take(200),
			ctx.db
				.query("p2pSessions")
				.withIndex("by_purgeAt", (q) => q.eq("purgeAt", undefined))
				.take(200),
			ctx.db
				.query("p2pRequests")
				.withIndex("by_purgeAt", (q) => q.gt("purgeAt", 0).lt("purgeAt", now))
				.take(200),
			ctx.db
				.query("p2pSessions")
				.withIndex("by_purgeAt", (q) => q.gt("purgeAt", 0).lt("purgeAt", now))
				.take(200),
		]);
		const requestPurgeIds = new Set(requestPurges.map((item) => item._id));
		const sessionPurgeIds = new Set(sessionPurges.map((item) => item._id));
		const requestExpirationIds = new Set(
			pendingRequests.map((item) => item._id),
		);
		const sessionExpirationIds = new Set(
			[...negotiatingSessions, ...readySessions].map((item) => item._id),
		);
		const requestExpirations = [];
		for (const request of pendingRequests) {
			if (requestPurgeIds.has(request._id)) continue;
			requestExpirations.push(
				ctx.db.patch(request._id, {
					status: "expired",
					updatedAt: now,
					terminalAt: request.expiresAt,
					purgeAt: request.expiresAt + TERMINAL_RETENTION_MS,
				}),
			);
		}
		const sessionExpirations = [];
		for (const session of [...negotiatingSessions, ...readySessions]) {
			if (sessionPurgeIds.has(session._id)) continue;
			sessionExpirations.push(
				ctx.db.patch(session._id, {
					status: "expired",
					updatedAt: now,
					terminalAt: session.expiresAt,
					purgeAt: session.expiresAt + TERMINAL_RETENTION_MS,
				}),
			);
		}
		const legacyBackfills = [
			...legacyRequests
				.filter((request) => !requestExpirationIds.has(request._id))
				.map((request) =>
					ctx.db.patch(request._id, {
						terminalAt:
							request.status === "pending" ? undefined : request.updatedAt,
						purgeAt:
							(request.status === "pending"
								? request.expiresAt
								: request.updatedAt) + TERMINAL_RETENTION_MS,
					}),
				),
			...legacySessions
				.filter((session) => !sessionExpirationIds.has(session._id))
				.map((session) =>
					ctx.db.patch(session._id, {
						terminalAt:
							session.status === "negotiating" || session.status === "ready"
								? undefined
								: session.updatedAt,
						purgeAt:
							(session.status === "negotiating" || session.status === "ready"
								? session.expiresAt
								: session.updatedAt) + TERMINAL_RETENTION_MS,
					}),
				),
		];
		await Promise.all([
			...inboxTokens.map((item) => ctx.db.delete(item._id)),
			...commands.map((item) => ctx.db.delete(item._id)),
			...requestExpirations,
			...sessionExpirations,
			...legacyBackfills,
			...requestPurges.map((item) => ctx.db.delete(item._id)),
			...sessionPurges.map((item) => ctx.db.delete(item._id)),
		]);
	},
});
