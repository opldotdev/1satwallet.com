import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { LockingScript, Transaction } from "@bsv/sdk";
import {
	type PeerPayOutbox,
	type PeerPayPaymentToken,
	peerPayOutbox,
	peerPayOutboxKey,
	retryPeerPayDelivery,
	runPeerPaySend,
} from "@/lib/wallet/peerpay-send";

const quiet = { error: console.error };
const logged: unknown[][] = [];
beforeEach(() => {
	logged.length = 0;
	console.error = (...args: unknown[]) => {
		logged.push(args);
	};
});
afterEach(() => {
	console.error = quiet.error;
});
/** This module's own log lines (diagnostics may log beside them). */
const ownLogs = () =>
	logged.filter((args) =>
		/^\[wallet\.|^\[peerpay-send\]/.test(String(args[0])),
	);

function memoryStorage() {
	const map = new Map<string, string>();
	return {
		map,
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => {
			map.set(k, v);
		},
	};
}

/** An input-less transaction as Atomic BEEF, standing in for a built payment. */
function token(satoshis = 1500): { token: PeerPayPaymentToken; txid: string } {
	const tx = new Transaction();
	tx.addOutput({ lockingScript: new LockingScript([]), satoshis });
	return {
		txid: tx.id("hex"),
		token: {
			customInstructions: {
				derivationPrefix: "cA==",
				derivationSuffix: "cw==",
			},
			transaction: tx.toAtomicBEEF(),
			amount: satoshis,
		},
	};
}

const RECIPIENT = `02${"ab".repeat(32)}`;
const now = () => new Date("2026-11-20T10:00:00Z");

describe("PeerPay outbox", () => {
	it("keeps entries per chain and identity, newest first", () => {
		const storage = memoryStorage();
		const box = peerPayOutbox(storage, "main", "me");
		const a = token(1);
		const b = token(2);
		box.put({
			txid: a.txid,
			recipient: RECIPIENT,
			satoshis: 1,
			token: a.token,
			createdAt: "2026-11-19T00:00:00.000Z",
		});
		box.put({
			txid: b.txid,
			recipient: RECIPIENT,
			satoshis: 2,
			token: b.token,
			createdAt: "2026-11-20T00:00:00.000Z",
		});
		assert.deepEqual(
			box.list().map((e) => e.satoshis),
			[2, 1],
		);
		assert.equal(peerPayOutbox(storage, "test", "me").list().length, 0);
		box.remove(a.txid);
		assert.deepEqual(
			box.list().map((e) => e.txid),
			[b.txid],
		);
	});

	it("reads an unreadable value as empty and logs it", () => {
		const storage = memoryStorage();
		storage.setItem(peerPayOutboxKey("main", "me"), "{not json");
		assert.deepEqual(peerPayOutbox(storage, "main", "me").list(), []);
		assert.equal(ownLogs().length, 1);
	});
});

describe("runPeerPaySend", () => {
	it("builds, keeps the token, delivers it, then forgets it", async () => {
		const storage = memoryStorage();
		const outbox = peerPayOutbox(storage, "main", "me");
		const built = token();
		const seenInOutbox: number[] = [];
		const delivered: [string, PeerPayPaymentToken][] = [];
		const outcome = await runPeerPaySend(
			{ recipient: RECIPIENT, satoshis: 1500 },
			{
				createToken: async (recipient, satoshis) => {
					assert.equal(recipient, RECIPIENT);
					assert.equal(satoshis, 1500);
					return built.token;
				},
				deliver: async (recipient, t) => {
					seenInOutbox.push(outbox.list().length);
					delivered.push([recipient, t]);
				},
				outbox,
				now,
			},
		);
		assert.deepEqual(seenInOutbox, [1]);
		assert.deepEqual(delivered, [[RECIPIENT, built.token]]);
		assert.equal(outcome.kind, "sent");
		assert.equal((outcome as { txid: string }).txid, built.txid);
		assert.deepEqual(outbox.list(), []);
	});

	it("keeps a payment whose delivery failed, and a retry sends the same token", async () => {
		const storage = memoryStorage();
		const outbox: PeerPayOutbox = peerPayOutbox(storage, "main", "me");
		const built = token();
		const outcome = await runPeerPaySend(
			{ recipient: RECIPIENT, satoshis: 1500 },
			{
				createToken: async () => built.token,
				deliver: async () => {
					throw new Error("502 Bad Gateway");
				},
				outbox,
				now,
			},
		);
		assert.equal(outcome.kind, "undelivered");
		assert.match(outcome.message, /Retry delivery/);
		assert.equal(ownLogs().length, 1);
		const [kept] = outbox.list();
		assert.equal(kept.txid, built.txid);
		assert.equal(kept.createdAt, "2026-11-20T10:00:00.000Z");

		const failed = await retryPeerPayDelivery(kept, {
			deliver: async () => {
				throw new Error("still down");
			},
			outbox,
		});
		assert.equal(failed.ok, false);
		assert.equal(outbox.list().length, 1);

		const sent: PeerPayPaymentToken[] = [];
		const retried = await retryPeerPayDelivery(kept, {
			deliver: async (_r, t) => {
				sent.push(t);
			},
			outbox,
		});
		assert.deepEqual(retried, { ok: true });
		assert.deepEqual(sent, [built.token]);
		assert.deepEqual(outbox.list(), []);
	});

	it("reports a build that failed as nothing sent", async () => {
		const outbox = peerPayOutbox(memoryStorage(), "main", "me");
		let delivered = false;
		const outcome = await runPeerPaySend(
			{ recipient: RECIPIENT, satoshis: 1 },
			{
				createToken: async () => {
					throw new Error("WERR_INSUFFICIENT_FUNDS: Insufficient funds");
				},
				deliver: async () => {
					delivered = true;
				},
				outbox,
			},
		);
		assert.deepEqual(outcome, {
			kind: "failed",
			message:
				"The wallet does not have enough spendable BSV for this amount and its fee.",
		});
		assert.equal(delivered, false);
		assert.deepEqual(outbox.list(), []);
	});
});
