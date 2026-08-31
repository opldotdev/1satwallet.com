import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
	Hash,
	PrivateKey,
	ProtoWallet,
	Utils,
	type WalletInterface,
} from "@bsv/sdk";
import {
	INBOX_RENEWAL_LEAD_MS,
	inboxRenewalDelay,
	recoverActiveSession,
} from "../components/landing/trade-request-lifecycle";
import {
	acceptRequest,
	cancelSession,
	deleteExpiredRecords,
	getSession,
	inbox,
	openInbox,
	sendRequest,
	TERMINAL_RETENTION_MS,
	updateOffer,
} from "../convex/p2p";
import {
	P2P_COMMAND_DOMAIN,
	P2P_COMMAND_TTL_MS,
	P2P_COMMAND_VERSION,
	type P2PAction,
	type SignedP2PCommand,
} from "../lib/p2p-auth";

type TestDocument = Record<string, unknown> & {
	_id: string;
	_creationTime: number;
};
type Comparison = {
	field: string;
	op: "eq" | "gt" | "lt";
	value: unknown;
};

class RangeBuilder {
	readonly comparisons: Comparison[] = [];

	eq(field: string, value: unknown) {
		this.comparisons.push({ field, op: "eq", value });
		return this;
	}

	gt(field: string, value: unknown) {
		this.comparisons.push({ field, op: "gt", value });
		return this;
	}

	lt(field: string, value: unknown) {
		this.comparisons.push({ field, op: "lt", value });
		return this;
	}
}

class TestQuery {
	private comparisons: Comparison[] = [];
	private direction: "asc" | "desc" = "asc";
	private readonly database: TestDatabase;
	private readonly tableName: string;

	constructor(database: TestDatabase, tableName: string) {
		this.database = database;
		this.tableName = tableName;
	}

	withIndex(_name: string, build: (range: RangeBuilder) => RangeBuilder) {
		const range = new RangeBuilder();
		build(range);
		this.comparisons = range.comparisons;
		return this;
	}

	order(direction: "asc" | "desc") {
		this.direction = direction;
		return this;
	}

	private values(): TestDocument[] {
		const matches = this.database.table(this.tableName).filter((document) =>
			this.comparisons.every(({ field, op, value }) => {
				const candidate = document[field];
				if (op === "eq") return candidate === value;
				if (op === "gt")
					return typeof candidate === "number" && candidate > Number(value);
				return typeof candidate === "number" && candidate < Number(value);
			}),
		);
		return matches.sort((left, right) =>
			this.direction === "desc"
				? right._creationTime - left._creationTime
				: left._creationTime - right._creationTime,
		);
	}

	async take(limit: number) {
		return this.values().slice(0, limit);
	}

	async first() {
		return this.values()[0] ?? null;
	}
}

class TestDatabase {
	private readonly tables = new Map<string, TestDocument[]>();
	private sequence = 0;

	table(name: string): TestDocument[] {
		const existing = this.tables.get(name);
		if (existing) return existing;
		const created: TestDocument[] = [];
		this.tables.set(name, created);
		return created;
	}

	query(name: string) {
		return new TestQuery(this, name);
	}

	async insert(name: string, value: Record<string, unknown>) {
		this.sequence += 1;
		const id = `${name}:${this.sequence}`;
		this.table(name).push({
			...structuredClone(value),
			_id: id,
			_creationTime: Date.now() + this.sequence,
		});
		return id;
	}

	async patch(id: string, value: Record<string, unknown>) {
		for (const documents of this.tables.values()) {
			const document = documents.find((candidate) => candidate._id === id);
			if (document) {
				Object.assign(document, structuredClone(value));
				return;
			}
		}
		throw new Error(`Unknown test document: ${id}`);
	}

	async delete(id: string) {
		for (const documents of this.tables.values()) {
			const index = documents.findIndex((candidate) => candidate._id === id);
			if (index >= 0) {
				documents.splice(index, 1);
				return;
			}
		}
	}
}

type TestContext = { db: TestDatabase };
type RegisteredHandler<Args, Result> = {
	_handler: (context: TestContext, args: Args) => Promise<Result>;
};

function invoke<Args, Result>(
	registered: unknown,
	context: TestContext,
	args: Args,
): Promise<Result> {
	return (registered as RegisteredHandler<Args, Result>)._handler(
		context,
		args,
	);
}

async function identity(wallet: WalletInterface): Promise<string> {
	return (await wallet.getPublicKey({ identityKey: true })).publicKey;
}

async function signed(
	wallet: WalletInterface,
	action: P2PAction,
	payload: Record<string, unknown>,
): Promise<SignedP2PCommand> {
	const { publicKey } = await wallet.getPublicKey({ identityKey: true });
	const issuedAt = Date.now();
	const body = JSON.stringify({
		v: P2P_COMMAND_VERSION,
		domain: P2P_COMMAND_DOMAIN,
		action,
		identityKey: publicKey,
		nonce: crypto.randomUUID(),
		issuedAt,
		expiresAt: issuedAt + P2P_COMMAND_TTL_MS,
		payload,
	});
	const timestamp = new Date(issuedAt).toISOString();
	const path = `/p2p/${action}`;
	const bodyHash = Utils.toHex(Hash.sha256(Utils.toArray(body, "utf8")));
	const message = `${path}|${timestamp}|${bodyHash}`;
	const keyId = Array.from(crypto.getRandomValues(new Uint8Array(32)));
	const { signature } = await wallet.createSignature({
		protocolID: [2, "message signing"],
		keyID: Utils.toBase64(keyId),
		counterparty: "anyone",
		data: Utils.toArray(message, "utf8"),
	});
	const envelope = [
		66,
		66,
		51,
		1,
		...Utils.toArray(publicKey, "hex"),
		0,
		...keyId,
		...signature,
	];
	return {
		body,
		signature: `${publicKey}|brc77|${timestamp}|${path}|${Utils.toBase64(envelope)}`,
	};
}

interface TestSession {
	sessionId: string;
	status: "negotiating" | "ready" | "cancelled" | "expired";
	expiresAt: number;
	initiatorIdentity: string;
	participantIdentity: string;
	initiatorLocked: boolean;
	participantLocked: boolean;
	participantRevision: number;
	purgeAt?: number;
}

const originalNow = Date.now;
afterEach(() => {
	Date.now = originalNow;
});

describe("signed P2P negotiation lifecycle", () => {
	test("authenticates, recovers both roles, renews capabilities, and rejects replay abuse", async () => {
		let now = 1_800_000_000_000;
		Date.now = () => now;
		const context = { db: new TestDatabase() };
		const initiator = new ProtoWallet(
			PrivateKey.fromRandom(),
		) as WalletInterface;
		const participant = new ProtoWallet(
			PrivateKey.fromRandom(),
		) as WalletInterface;
		const attacker = new ProtoWallet(
			PrivateKey.fromRandom(),
		) as WalletInterface;
		const initiatorIdentity = await identity(initiator);
		const participantIdentity = await identity(participant);
		const initiatorToken = crypto.randomUUID();
		const participantToken = crypto.randomUUID();

		const firstOpen = await invoke<SignedP2PCommand, { expiresAt: number }>(
			openInbox,
			context,
			await signed(initiator, "inbox.open", { token: initiatorToken }),
		);
		await invoke(
			openInbox,
			context,
			await signed(participant, "inbox.open", { token: participantToken }),
		);
		assert.equal(
			inboxRenewalDelay(firstOpen.expiresAt, now),
			firstOpen.expiresAt - now - INBOX_RENEWAL_LEAD_MS,
		);
		assert.equal(inboxRenewalDelay(now + 500, now), 1_000);

		const requestId = crypto.randomUUID();
		const requestCommand = await signed(initiator, "request.create", {
			requestId,
			toIdentity: participantIdentity,
		});
		const firstRequest = await invoke(sendRequest, context, requestCommand);
		const replayedRequest = await invoke(sendRequest, context, requestCommand);
		assert.deepEqual(replayedRequest, firstRequest);
		assert.equal(context.db.table("p2pRequests").length, 1);

		const tampered = JSON.parse(requestCommand.body) as Record<string, unknown>;
		tampered.nonce = crypto.randomUUID();
		await assert.rejects(
			invoke(sendRequest, context, {
				...requestCommand,
				body: JSON.stringify(tampered),
			}),
			/Invalid command signature/,
		);
		await assert.rejects(
			invoke(
				acceptRequest,
				context,
				await signed(attacker, "request.accept", {
					requestId,
					sessionId: crypto.randomUUID(),
				}),
			),
			/Trade request not found/,
		);

		const proposedSessionId = crypto.randomUUID();
		const accepted = await invoke<SignedP2PCommand, { sessionId: string }>(
			acceptRequest,
			context,
			await signed(participant, "request.accept", {
				requestId,
				sessionId: proposedSessionId,
			}),
		);
		const doubleSubmitted = await invoke<
			SignedP2PCommand,
			{ sessionId: string }
		>(
			acceptRequest,
			context,
			await signed(participant, "request.accept", {
				requestId,
				sessionId: crypto.randomUUID(),
			}),
		);
		assert.equal(accepted.sessionId, proposedSessionId);
		assert.equal(doubleSubmitted.sessionId, proposedSessionId);
		assert.equal(context.db.table("p2pSessions").length, 1);

		const initiatorInbox = await invoke<
			{ token: string },
			{ activeSessions: TestSession[] }
		>(inbox, context, { token: initiatorToken });
		const participantInbox = await invoke<
			{ token: string },
			{ activeSessions: TestSession[] }
		>(inbox, context, { token: participantToken });
		assert.equal(
			initiatorInbox.activeSessions[0]?.sessionId,
			proposedSessionId,
		);
		assert.equal(
			participantInbox.activeSessions[0]?.sessionId,
			proposedSessionId,
		);
		assert.deepEqual(
			recoverActiveSession(initiatorInbox.activeSessions[0], initiatorIdentity),
			{ sessionId: proposedSessionId, peerIdentity: participantIdentity },
		);
		assert.deepEqual(
			recoverActiveSession(
				participantInbox.activeSessions[0],
				participantIdentity,
			),
			{ sessionId: proposedSessionId, peerIdentity: initiatorIdentity },
		);
		assert.equal(
			recoverActiveSession(
				participantInbox.activeSessions[0],
				await identity(attacker),
			),
			null,
		);

		now += 11 * 60 * 60 * 1000;
		const renewed = await invoke<SignedP2PCommand, { expiresAt: number }>(
			openInbox,
			context,
			await signed(initiator, "inbox.open", { token: initiatorToken }),
		);
		assert.ok(renewed.expiresAt > firstOpen.expiresAt);
		assert.equal(context.db.table("p2pInboxTokens").length, 2);
	});

	test("invalidates peer locks on changes and expires immediately at read time", async () => {
		let now = 1_800_100_000_000;
		Date.now = () => now;
		const context = { db: new TestDatabase() };
		const initiator = new ProtoWallet(
			PrivateKey.fromRandom(),
		) as WalletInterface;
		const participant = new ProtoWallet(
			PrivateKey.fromRandom(),
		) as WalletInterface;
		const participantIdentity = await identity(participant);
		const requestId = crypto.randomUUID();
		const sessionId = crypto.randomUUID();

		await invoke(
			sendRequest,
			context,
			await signed(initiator, "request.create", {
				requestId,
				toIdentity: participantIdentity,
			}),
		);
		await invoke(
			acceptRequest,
			context,
			await signed(participant, "request.accept", { requestId, sessionId }),
		);
		const item = {
			type: "satoshis",
			id: "bsv",
			name: "BSV",
			satoshis: 1,
		};
		await invoke(
			updateOffer,
			context,
			await signed(initiator, "session.offer", {
				sessionId,
				revision: 1,
				locked: false,
				items: [item],
			}),
		);
		await invoke(
			updateOffer,
			context,
			await signed(participant, "session.offer", {
				sessionId,
				revision: 1,
				locked: false,
				items: [item],
			}),
		);
		await invoke(
			updateOffer,
			context,
			await signed(initiator, "session.offer", {
				sessionId,
				revision: 2,
				locked: true,
				items: [item],
			}),
		);
		const participantLock = await signed(participant, "session.offer", {
			sessionId,
			revision: 2,
			locked: true,
			items: [item],
		});
		const ready = await invoke<
			SignedP2PCommand,
			{ status: TestSession["status"] }
		>(updateOffer, context, participantLock);
		assert.equal(ready.status, "ready");
		assert.equal(
			(
				await invoke<SignedP2PCommand, { status: TestSession["status"] }>(
					updateOffer,
					context,
					participantLock,
				)
			).status,
			"ready",
		);

		const changed = await invoke<
			SignedP2PCommand,
			{ status: TestSession["status"] }
		>(
			updateOffer,
			context,
			await signed(initiator, "session.offer", {
				sessionId,
				revision: 3,
				locked: true,
				items: [{ ...item, satoshis: 2 }],
			}),
		);
		assert.equal(changed.status, "negotiating");
		const rawSession = context.db.table(
			"p2pSessions",
		)[0] as unknown as TestSession;
		assert.equal(rawSession.initiatorLocked, true);
		assert.equal(rawSession.participantLocked, false);
		await assert.rejects(
			invoke(
				updateOffer,
				context,
				await signed(participant, "session.offer", {
					sessionId,
					revision: 2,
					locked: true,
					items: [item],
				}),
			),
			/Offer changed/,
		);

		now = rawSession.expiresAt + 1;
		const expired = await invoke<{ sessionId: string }, TestSession | null>(
			getSession,
			context,
			{ sessionId },
		);
		assert.equal(expired?.status, "expired");
		await assert.rejects(
			invoke(
				cancelSession,
				context,
				await signed(initiator, "session.cancel", { sessionId }),
			),
			/expired/,
		);
		assert.equal(rawSession.status, "negotiating");

		await invoke(deleteExpiredRecords, context, {});
		assert.equal(rawSession.status, "expired");
		now = rawSession.expiresAt + TERMINAL_RETENTION_MS + 1;
		await invoke(deleteExpiredRecords, context, {});
		assert.equal(context.db.table("p2pSessions").length, 0);
		assert.equal(context.db.table("p2pRequests").length, 0);
	});

	test("allows only a peer to cancel and keeps terminal transitions monotonic", async () => {
		let now = 1_800_200_000_000;
		Date.now = () => now;
		const context = { db: new TestDatabase() };
		const initiator = new ProtoWallet(
			PrivateKey.fromRandom(),
		) as WalletInterface;
		const participant = new ProtoWallet(
			PrivateKey.fromRandom(),
		) as WalletInterface;
		const attacker = new ProtoWallet(
			PrivateKey.fromRandom(),
		) as WalletInterface;
		const requestId = crypto.randomUUID();
		const sessionId = crypto.randomUUID();
		await invoke(
			sendRequest,
			context,
			await signed(initiator, "request.create", {
				requestId,
				toIdentity: await identity(participant),
			}),
		);
		await invoke(
			acceptRequest,
			context,
			await signed(participant, "request.accept", { requestId, sessionId }),
		);
		await assert.rejects(
			invoke(
				cancelSession,
				context,
				await signed(attacker, "session.cancel", { sessionId }),
			),
			/Not authorized/,
		);

		const cancellation = await signed(participant, "session.cancel", {
			sessionId,
		});
		await invoke(cancelSession, context, cancellation);
		await invoke(cancelSession, context, cancellation);
		await invoke(
			cancelSession,
			context,
			await signed(participant, "session.cancel", { sessionId }),
		);
		const session = context.db.table(
			"p2pSessions",
		)[0] as unknown as TestSession;
		assert.equal(session.status, "cancelled");
		await assert.rejects(
			invoke(
				updateOffer,
				context,
				await signed(initiator, "session.offer", {
					sessionId,
					revision: 1,
					locked: false,
					items: [],
				}),
			),
			/closed/,
		);

		assert.ok(session.purgeAt);
		now = (session.purgeAt ?? now) - 1;
		await invoke(deleteExpiredRecords, context, {});
		assert.equal(context.db.table("p2pSessions").length, 1);
		now += 2;
		await invoke(deleteExpiredRecords, context, {});
		assert.equal(context.db.table("p2pSessions").length, 0);
	});
});
