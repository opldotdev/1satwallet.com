import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { PeerMessage } from "@bsv/message-box-client";
import {
	P2PKH,
	PrivateKey,
	ProtoWallet,
	PublicKey,
	Transaction,
	type WalletInterface,
} from "@bsv/sdk";
import { messageboxReadHostsOf } from "@/lib/chain-endpoints";
import {
	type InboxSyncOutcome,
	loadIncomingPayments,
	saveInboxSync,
} from "@/lib/wallet/incoming-payments";
import {
	combineInboxResults,
	type InboxClient,
	type InboxWallet,
	paymentKeyOf,
	peerPayPaymentOf,
	RETRY_REASON,
	syncPeerPayInbox,
	UNREADABLE_REASON,
} from "@/lib/wallet/peerpay-inbox";

const OWN = "https://messagebox.1sat.app";
const EXTRA = "https://messagebox.bsvblockchain.tech";
const sender = PrivateKey.fromRandom().toPublicKey().toString();
const recipient = new ProtoWallet(PrivateKey.fromRandom());
const PREFIX = "cHJl";
const SUFFIX = "c3Vm";

/** A transaction paying `satoshis` to the recipient's PeerPay key for `suffix`. */
async function paidTx(satoshis = 1000, suffix = SUFFIX): Promise<number[]> {
	const { publicKey } = await recipient.getPublicKey({
		protocolID: [2, "3241645161d8"],
		keyID: `${PREFIX} ${suffix}`,
		counterparty: sender,
		forSelf: true,
	});
	const tx = new Transaction();
	tx.addOutput({
		lockingScript: new P2PKH().lock(PublicKey.fromString(publicKey).toHash()),
		satoshis,
	});
	return tx.toAtomicBEEF(true);
}

function message(
	messageId: string,
	transaction: number[],
	options: { amount?: number; prefix?: string; suffix?: string } = {},
): PeerMessage {
	return {
		messageId,
		sender,
		created_at: "2026-11-16T10:00:00.000Z",
		updated_at: "2026-11-16T10:00:00.000Z",
		body: JSON.stringify({
			customInstructions: {
				derivationPrefix: options.prefix ?? PREFIX,
				derivationSuffix: options.suffix ?? SUFFIX,
			},
			transaction,
			amount: options.amount ?? 1000,
		}),
	};
}

const paymailMessage: PeerMessage = {
	messageId: "paymail-1",
	sender,
	created_at: "2026-11-16T10:00:00.000Z",
	updated_at: "2026-11-16T10:00:00.000Z",
	body: { beef: "00", outputIndex: 0, alias: "alice" },
};

function fakeBoxes(boxes: Record<string, PeerMessage[] | Error>) {
	const acknowledged: { host: string; messageIds: string[] }[] = [];
	const listings: Parameters<InboxClient["listMessages"]>[0][] = [];
	const clientFor = (host: string): InboxClient => ({
		async listMessages(args) {
			assert.equal(args.host, host);
			assert.equal(args.messageBox, "payment_inbox");
			listings.push(args);
			const box = boxes[host];
			if (box instanceof Error) throw box;
			return box ?? [];
		},
		async acknowledgeMessage({ messageIds, host: ackHost }) {
			acknowledged.push({ host: ackHost, messageIds });
			return "success";
		},
	});
	return { acknowledged, listings, clientFor };
}

function fakeWallet(
	options: { internalize?: () => Promise<unknown>; keyFails?: boolean } = {},
) {
	const internalized: Parameters<WalletInterface["internalizeAction"]>[0][] =
		[];
	const wallet: InboxWallet = {
		getPublicKey: async (args) => {
			if (options.keyFails) throw new Error("wallet locked");
			return recipient.getPublicKey(args);
		},
		internalizeAction: async (args) => {
			internalized.push(args);
			return ((await options.internalize?.()) ?? {
				accepted: true,
			}) as Awaited<ReturnType<WalletInterface["internalizeAction"]>>;
		},
	};
	return { wallet, internalized };
}

async function quietConsole<T>(run: () => Promise<T>) {
	const { error, warn } = console;
	const logged: unknown[][] = [];
	console.error = (...args: unknown[]) => void logged.push(args);
	console.warn = (...args: unknown[]) => void logged.push(args);
	try {
		return { result: await run(), logged };
	} finally {
		console.error = error;
		console.warn = warn;
	}
}

const peerpayLogs = (logged: unknown[][]) =>
	logged.filter(([label]) => String(label).startsWith("[peerpay]"));

async function sync(
	boxes: Record<string, PeerMessage[] | Error>,
	wallet: InboxWallet,
	hosts = [OWN, EXTRA],
) {
	const fake = fakeBoxes(boxes);
	const outcomes: InboxSyncOutcome[] = [];
	const run = await quietConsole(() =>
		syncPeerPayInbox({
			hosts,
			clientFor: fake.clientFor,
			wallet,
			record: (outcome) => outcomes.push(outcome),
			now: () => 1,
		}),
	);
	return { ...run, ...fake, outcome: outcomes[0] as InboxSyncOutcome };
}

describe("PeerPay inbox", () => {
	it("reads the own box first, then the chain's extra read boxes", () => {
		assert.deepEqual(messageboxReadHostsOf("main"), [OWN, EXTRA]);
		assert.deepEqual(messageboxReadHostsOf("test"), [
			"https://testnet.messagebox.1sat.app",
		]);
	});

	it("reads PeerPay tokens and leaves paymail messages to syncMessages", async () => {
		const payment = peerPayPaymentOf(message("m1", await paidTx()), OWN);
		assert.equal(payment?.token.amount, 1000);
		assert.equal(payment?.token.outputIndex, 0);
		assert.equal(payment?.createdAt, "2026-11-16T10:00:00.000Z");
		assert.equal(peerPayPaymentOf(paymailMessage, OWN), null);
	});

	it("takes a payment found on two boxes once and acknowledges each copy on its own box", async () => {
		const tx = await paidTx();
		const { wallet, internalized } = fakeWallet();
		const run = await sync(
			{
				[OWN]: [message("own-1", tx), paymailMessage],
				[EXTRA]: [
					message("extra-9", tx),
					message("extra-2", await paidTx(500), { amount: 500 }),
				],
			},
			wallet,
		);
		assert.equal(internalized.length, 2);
		assert.deepEqual(internalized[0]?.labels, ["peerpay"]);
		assert.equal(
			internalized[0]?.outputs[0]?.paymentRemittance?.senderIdentityKey,
			sender,
		);
		assert.deepEqual(run.acknowledged, [
			{ host: OWN, messageIds: ["own-1"] },
			{ host: EXTRA, messageIds: ["extra-9", "extra-2"] },
		]);
		assert.deepEqual(run.result, {
			processed: 2,
			failed: 0,
			leftOnOwnHost: 0,
			unreachableHosts: [],
		});
		assert.deepEqual(
			run.outcome.updates.map((r) => [r.messageId, r.host, r.status]),
			[
				["own-1", OWN, "received"],
				["extra-2", EXTRA, "received"],
			],
		);
	});

	it("does not dedupe the same output from different senders", async () => {
		const tx = await paidTx();
		const a = peerPayPaymentOf(message("a", tx), OWN);
		const other = PrivateKey.fromRandom().toPublicKey().toString();
		const b = peerPayPaymentOf({ ...message("b", tx), sender: other }, EXTRA);
		assert.ok(a && b);
		assert.notEqual(paymentKeyOf(a), paymentKeyOf(b));
	});

	it("keeps a payment internalizeAction refused for retry, on every box, and logs the details", async () => {
		const tx = await paidTx();
		const { wallet } = fakeWallet({
			internalize: async () => {
				throw new Error("storage unavailable: 503");
			},
		});
		const run = await sync(
			{ [OWN]: [message("own-1", tx)], [EXTRA]: [message("extra-1", tx)] },
			wallet,
		);
		assert.deepEqual(run.acknowledged, []);
		assert.equal(run.result.failed, 1);
		assert.equal(run.result.leftOnOwnHost, 1);
		const [record] = run.outcome.updates;
		assert.equal(record?.status, "failed");
		assert.equal(record?.reason, RETRY_REASON.wallet);
		const log = peerpayLogs(run.logged).find(([label]) =>
			String(label).includes("internalize"),
		);
		assert.ok(log, "the failure is logged");
		const detail = log[1] as Record<string, unknown>;
		assert.equal(detail.host, OWN);
		assert.equal(detail.messageId, "own-1");
		assert.equal(detail.sender, sender);
		assert.match(String(detail.error), /storage unavailable: 503/);
		// syncMessages fails the same leftover message: counted once.
		assert.deepEqual(
			combineInboxResults(run.result, { processed: 0, failed: 1 }),
			{ processed: 0, failed: 1 },
		);
	});

	it("treats a failed key lookup as retryable", async () => {
		const { wallet, internalized } = fakeWallet({ keyFails: true });
		const run = await sync(
			{ [OWN]: [message("own-1", await paidTx())] },
			wallet,
			[OWN],
		);
		assert.equal(internalized.length, 0);
		assert.deepEqual(run.acknowledged, []);
		assert.equal(run.result.failed, 1);
		assert.equal(run.outcome.updates[0]?.reason, RETRY_REASON.key);
	});

	it("leaves a token that can never be accepted in the box, unacknowledged and not counted as a failure", async () => {
		const good = await paidTx();
		const cases: [PeerMessage, string][] = [
			[
				message("bad-prefix", good, { prefix: "not base64!" }),
				UNREADABLE_REASON.instructions,
			],
			[message("bad-beef", [1, 2, 3, 4, 5]), UNREADABLE_REASON.transaction],
			[message("bad-amount", good, { amount: 999 }), UNREADABLE_REASON.amount],
			[
				message("not-mine", good, { suffix: "b3RoZXI=" }),
				UNREADABLE_REASON.recipient,
			],
		];
		for (const [msg, reason] of cases) {
			const { wallet, internalized } = fakeWallet();
			const run = await sync({ [OWN]: [msg] }, wallet, [OWN]);
			assert.equal(internalized.length, 0, msg.messageId);
			assert.deepEqual(run.acknowledged, [], msg.messageId);
			assert.equal(run.result.failed, 0, msg.messageId);
			assert.equal(run.result.leftOnOwnHost, 1, msg.messageId);
			assert.equal(run.outcome.updates[0]?.status, "unreadable", msg.messageId);
			assert.equal(run.outcome.updates[0]?.reason, reason, msg.messageId);
			assert.deepEqual(
				combineInboxResults(run.result, { processed: 0, failed: 1 }),
				{ processed: 0, failed: 0 },
			);
		}
	});

	it("takes the next copy when the first fails the local checks", async () => {
		const tx = await paidTx();
		const { wallet, internalized } = fakeWallet();
		const run = await sync(
			{
				[OWN]: [message("own-1", tx, { suffix: "b3RoZXI=" })],
				[EXTRA]: [message("extra-1", tx)],
			},
			wallet,
		);
		assert.equal(internalized.length, 1);
		assert.equal(
			internalized[0]?.outputs[0]?.paymentRemittance?.derivationSuffix,
			SUFFIX,
		);
		assert.deepEqual(run.acknowledged, [
			{ host: OWN, messageIds: ["own-1"] },
			{ host: EXTRA, messageIds: ["extra-1"] },
		]);
		assert.equal(run.outcome.updates[0]?.status, "received");
		assert.equal(run.outcome.updates[0]?.host, EXTRA);
	});

	it("internalizes a payment listed again, with no local shortcut, and acknowledges it", async () => {
		const tx = await paidTx();
		const { wallet, internalized } = fakeWallet();
		for (let run = 0; run < 2; run += 1) {
			const { acknowledged } = await sync(
				{ [OWN]: [message("own-1", tx)] },
				wallet,
				[OWN],
			);
			assert.deepEqual(acknowledged, [{ host: OWN, messageIds: ["own-1"] }]);
		}
		assert.equal(internalized.length, 2);
	});

	it("reports an unreadable box, own or extra, and counts it", async () => {
		const { wallet } = fakeWallet();
		const extraDown = await sync(
			{ [OWN]: [], [EXTRA]: new Error("ECONNREFUSED") },
			wallet,
		);
		assert.deepEqual(extraDown.result.unreachableHosts, [EXTRA]);
		assert.equal(extraDown.result.failed, 1);
		assert.deepEqual(extraDown.outcome.unreachableHosts, [EXTRA]);
		assert.deepEqual(extraDown.outcome.listedHosts, [OWN]);
		assert.deepEqual(
			peerpayLogs(extraDown.logged).map(([label]) => label),
			["[peerpay] list failed"],
		);

		const ownDown = await sync({ [OWN]: new Error("HTTP 500") }, wallet, [OWN]);
		assert.deepEqual(ownDown.result.unreachableHosts, [OWN]);
		assert.equal(ownDown.result.failed, 1);
	});

	it("takes one window of a full box without throwing", async () => {
		const tx = await paidTx();
		const messages = Array.from({ length: 1001 }, (_, i) =>
			message(`m${i}`, tx, { prefix: "not base64!" }),
		);
		const { wallet } = fakeWallet();
		const run = await sync({ [OWN]: messages }, wallet, [OWN]);
		assert.deepEqual(run.listings[0], {
			messageBox: "payment_inbox",
			host: OWN,
			limit: 1001,
			pageSize: 100,
			maxPages: 11,
		});
		assert.ok(
			peerpayLogs(run.logged).some(([label]) =>
				String(label).includes("more than 1000"),
			),
		);
		assert.equal(run.result.leftOnOwnHost, 1001);
	});

	it("keeps the PeerPay result when the paymail sync threw", () => {
		assert.deepEqual(
			combineInboxResults(
				{ processed: 2, failed: 0, leftOnOwnHost: 0, unreachableHosts: [] },
				null,
			),
			{ processed: 2, failed: 1 },
		);
	});
});

describe("incoming payment records", () => {
	const scope = { chain: "main" as const, identityKey: sender };
	const record = (
		key: string,
		host: string,
		status: "received" | "failed" | "unreadable",
	) => ({
		key,
		messageId: key,
		host,
		sender,
		satoshis: 1000,
		createdAt: `2026-11-16T10:00:0${key.length % 10}.000Z`,
		status,
		reason: status === "received" ? null : "x",
		updatedAt: 1,
	});

	beforeEach(() => {
		const store = new Map<string, string>();
		Object.assign(globalThis, {
			window: {
				localStorage: {
					getItem: (k: string) => store.get(k) ?? null,
					setItem: (k: string, v: string) => store.set(k, v),
				},
				addEventListener: () => undefined,
				removeEventListener: () => undefined,
			},
		});
	});
	afterEach(() => {
		Reflect.deleteProperty(globalThis, "window");
	});

	it("drops a listed host's failed rows whose payment is gone, and keeps the rest", () => {
		saveInboxSync(scope, {
			updates: [
				record("gone", OWN, "failed"),
				record("gone-unreadable", OWN, "unreadable"),
				record("still", OWN, "failed"),
				record("extra-gone", EXTRA, "failed"),
				record("paid", OWN, "received"),
			],
			listedHosts: [OWN, EXTRA],
			listedKeys: new Set([
				"gone",
				"gone-unreadable",
				"still",
				"extra-gone",
				"paid",
			]),
			unreachableHosts: [],
		});
		saveInboxSync(scope, {
			updates: [],
			listedHosts: [OWN],
			listedKeys: new Set(["still"]),
			unreachableHosts: [EXTRA],
		});
		const state = loadIncomingPayments(scope);
		assert.deepEqual(state.records.map((r) => r.key).sort(), [
			"extra-gone",
			"paid",
			"still",
		]);
		assert.deepEqual(state.unreachableHosts, [EXTRA]);
	});

	it("never turns a received row back into a failure", () => {
		const outcome = {
			listedHosts: [OWN],
			listedKeys: new Set(["k"]),
			unreachableHosts: [],
		};
		saveInboxSync(scope, {
			...outcome,
			updates: [record("k", OWN, "received")],
		});
		saveInboxSync(scope, { ...outcome, updates: [record("k", OWN, "failed")] });
		assert.equal(loadIncomingPayments(scope).records[0]?.status, "received");
	});

	it("filters malformed rows and logs bad JSON once", () => {
		const key = `1sat:incoming-payments:main:${sender}`;
		const { localStorage } = (
			globalThis as unknown as { window: { localStorage: Storage } }
		).window;
		localStorage.setItem(
			key,
			JSON.stringify({
				records: [record("ok", OWN, "failed"), { key: 1 }, null],
				unreachableHosts: [EXTRA, 5],
			}),
		);
		const state = loadIncomingPayments(scope);
		assert.deepEqual(
			state.records.map((r) => r.key),
			["ok"],
		);
		assert.deepEqual(state.unreachableHosts, [EXTRA]);

		localStorage.setItem(key, "{not json");
		const errors: unknown[] = [];
		const { error } = console;
		console.error = (...args: unknown[]) => void errors.push(args);
		try {
			loadIncomingPayments(scope);
			loadIncomingPayments(scope);
		} finally {
			console.error = error;
		}
		assert.equal(errors.length, 1);
	});
});
