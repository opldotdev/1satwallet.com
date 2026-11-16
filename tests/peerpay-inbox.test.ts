import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MessageBoxClient, type PeerMessage } from "@bsv/message-box-client";
import {
	P2PKH,
	PrivateKey,
	ProtoWallet,
	PublicKey,
	Transaction,
	type WalletInterface,
	WERR_INVALID_PARAMETER,
	WERR_REVIEW_ACTIONS,
} from "@bsv/sdk";
import { sdk as toolbox } from "@bsv/wallet-toolbox-client";
import { type Chain, messageboxReadHostsOf } from "@/lib/chain-endpoints";
import {
	type InboxSyncOutcome,
	loadIncomingPayments,
	saveInboxSync,
} from "@/lib/wallet/incoming-payments";
import {
	combineInboxResults,
	type InboxClient,
	type InboxWallet,
	MAX_WINDOWS,
	PEERPAY_LISTING,
	paymentKeyOf,
	peerPayPaymentOf,
	permanentRefusalOf,
	RETRY_REASON,
	syncPeerPayInbox,
	UNREADABLE_REASON,
} from "@/lib/wallet/peerpay-inbox";

const OWN = "https://messagebox.1sat.app";
const EXTRA = "https://messagebox.bsvblockchain.tech";
const senderKey = PrivateKey.fromRandom();
const sender = senderKey.toPublicKey().toString();
const senderWallet = new ProtoWallet(senderKey);
const recipientKey = PrivateKey.fromRandom();
const recipient = new ProtoWallet(recipientKey);
const ACCOUNT = {
	chain: "main" as Chain,
	identityKey: recipientKey.toPublicKey().toString(),
};
const PREFIX = "cHJl";
const SUFFIX = "c3Vm";

/**
 * A transaction paying `satoshis` to the recipient, derived on the sender's
 * side as `PeerPayClient.createPaymentToken` does (counterparty: the
 * recipient), so the recipient-side check is not checked against itself.
 */
async function paidTx(satoshis = 1000, suffix = SUFFIX): Promise<number[]> {
	const { publicKey } = await senderWallet.getPublicKey({
		protocolID: [2, "3241645161d8"],
		keyID: `${PREFIX} ${suffix}`,
		counterparty: recipientKey.toPublicKey().toString(),
		forSelf: false,
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
			return (box ?? []).slice(args.offset, args.offset + args.limit);
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
	account = ACCOUNT,
) {
	const fake = fakeBoxes(boxes);
	const outcomes: InboxSyncOutcome[] = [];
	const run = await quietConsole(() =>
		syncPeerPayInbox({
			hosts,
			clientFor: fake.clientFor,
			wallet,
			record: (outcome) => outcomes.push(outcome),
			account,
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

	it("reads past a full window, so messages never acknowledged don't hide a later payment", async () => {
		const junk = Array.from({ length: 1000 }, (_, i) => ({
			...paymailMessage,
			messageId: `junk-${i}`,
		}));
		const { wallet, internalized } = fakeWallet();
		const run = await sync(
			{ [OWN]: [...junk, message("late", await paidTx())] },
			wallet,
			[OWN],
		);
		assert.deepEqual(
			run.listings.map((l) => l.offset),
			[0, 1000, 2000],
		);
		assert.deepEqual(run.listings[0], {
			messageBox: "payment_inbox",
			host: OWN,
			offset: 0,
			...PEERPAY_LISTING,
		});
		assert.equal(internalized.length, 1);
		assert.deepEqual(run.acknowledged, [{ host: OWN, messageIds: ["late"] }]);
		assert.equal(run.result.leftOnOwnHost, 0);
	});

	it("keeps reading after a window cut short by a repeated message", async () => {
		const listings: number[] = [];
		const { wallet, internalized } = fakeWallet();
		const late = message("late", await paidTx());
		await quietConsole(() =>
			syncPeerPayInbox({
				hosts: [OWN],
				clientFor: () => ({
					async listMessages({ offset }) {
						listings.push(offset);
						// The box shifted mid-read: the first window lost one to a repeat.
						if (offset === 0)
							return Array.from({ length: 999 }, (_, i) => ({
								...paymailMessage,
								messageId: `j${i}`,
							}));
						if (offset === 1000) return [late];
						return [];
					},
					async acknowledgeMessage() {
						return "success";
					},
				}),
				wallet,
				record: () => undefined,
				account: ACCOUNT,
			}),
		);
		assert.deepEqual(listings, [0, 1000, 2000]);
		assert.equal(internalized.length, 1);
	});

	it("stops after one repeat on a server that ignores offset", async () => {
		const listings: number[] = [];
		const { wallet } = fakeWallet();
		const same = Array.from({ length: 1000 }, (_, i) => ({
			...paymailMessage,
			messageId: `s${i}`,
		}));
		const run = await quietConsole(() =>
			syncPeerPayInbox({
				hosts: [OWN],
				clientFor: () => ({
					async listMessages({ offset }) {
						listings.push(offset);
						return same;
					},
					async acknowledgeMessage() {
						return "success";
					},
				}),
				wallet,
				record: () => undefined,
				account: ACCOUNT,
			}),
		);
		assert.deepEqual(listings, [0, 1000]);
		assert.equal(
			peerpayLogs(run.logged).some(([label]) =>
				String(label).includes("windows"),
			),
			false,
		);
	});

	it("stops at the window bound on a box that never ends, and logs the counts", async () => {
		const listings: number[] = [];
		const { wallet } = fakeWallet();
		const run = await quietConsole(() =>
			syncPeerPayInbox({
				hosts: [OWN],
				clientFor: () => ({
					async listMessages({ offset, limit }) {
						listings.push(offset);
						return Array.from({ length: limit }, (_, i) => ({
							...paymailMessage,
							messageId: `w${offset + i}`,
						}));
					},
					async acknowledgeMessage() {
						return "success";
					},
				}),
				wallet,
				record: () => undefined,
				account: ACCOUNT,
			}),
		);
		assert.equal(listings.length, MAX_WINDOWS);
		assert.deepEqual(run.result.unreachableHosts, []);
		const log = peerpayLogs(run.logged).find(([label]) =>
			String(label).includes(`after ${MAX_WINDOWS} windows`),
		);
		assert.ok(log, "the bound is logged");
		assert.deepEqual(log[1], {
			host: OWN,
			windows: MAX_WINDOWS,
			windowSize: 1000,
			messagesRead: MAX_WINDOWS * 1000,
		});
	});

	it("reads a box of 1500 messages through the real client, window by window", async () => {
		const stored: PeerMessage[] = Array.from({ length: 1500 }, (_, i) => ({
			messageId: `p${i}`,
			sender,
			created_at: "2026-11-16T10:00:00.000Z",
			updated_at: "2026-11-16T10:00:00.000Z",
			body: JSON.stringify({ beef: "00", outputIndex: 0, alias: "alice" }),
		}));
		stored[1200] = message("late", await paidTx());
		const client = new MessageBoxClient({
			walletClient: recipient as unknown as WalletInterface,
			host: OWN,
		});
		let pages = 0;
		const acknowledged: string[][] = [];
		Object.assign(client, {
			authenticatedFetch: async (url: string, config: { body: string }) => {
				if (url.endsWith("/acknowledgeMessage")) {
					const { messageIds } = JSON.parse(config.body) as {
						messageIds: string[];
					};
					acknowledged.push(messageIds);
					return { ok: true, json: async () => ({ status: "success" }) };
				}
				pages += 1;
				const { offset, limit } = JSON.parse(config.body) as {
					offset: number;
					limit: number;
				};
				const messages = stored.slice(offset, offset + limit);
				return {
					ok: true,
					json: async () => ({
						status: "success",
						messages,
						hasMore: offset + messages.length < stored.length,
					}),
				};
			},
		});
		const listed = await client.listMessages({
			messageBox: "payment_inbox",
			host: OWN,
			offset: 0,
			...PEERPAY_LISTING,
		});
		assert.equal(listed.length, 1000);
		assert.equal(pages, 10);

		pages = 0;
		const { wallet, internalized } = fakeWallet();
		const run = await quietConsole(() =>
			syncPeerPayInbox({
				hosts: [OWN],
				clientFor: () => client,
				wallet,
				record: () => undefined,
				account: ACCOUNT,
			}),
		);
		// 10 pages for the first window, 5 for the second, 1 empty one to end.
		assert.equal(pages, 16);
		assert.deepEqual(run.result.unreachableHosts, []);
		assert.equal(run.result.failed, 0);
		assert.equal(run.result.processed, 1);
		assert.equal(internalized.length, 1);
		assert.deepEqual(acknowledged, [["late"]]);
	});

	it("rejects an over-long derivation value locally, before the wallet's key lookup", async () => {
		const { wallet, internalized } = fakeWallet({ keyFails: true });
		const run = await sync(
			{ [OWN]: [message("long", await paidTx(), { prefix: "A".repeat(400) })] },
			wallet,
			[OWN],
		);
		assert.equal(internalized.length, 0);
		assert.equal(run.result.failed, 0);
		assert.equal(run.outcome.updates[0]?.status, "unreadable");
		assert.equal(
			run.outcome.updates[0]?.reason,
			UNREADABLE_REASON.instructions,
		);
	});

	it("classifies the wallet's permanent refusals by shape, SDK and toolbox alike", () => {
		const invalidStatus = (
			toolbox.WalletErrorFromJson as (json: unknown) => Error
		)({
			name: "WERR_INVALID_PARAMETER",
			parameter: "tx",
			message:
				"The tx parameter must be target transaction of internalizeAction has invalid status failed.",
		});
		const permanent: [Error, string][] = [
			[
				new WERR_INVALID_PARAMETER(
					"paymentRemittance",
					"locked by script conforming to BRC-29",
				),
				UNREADABLE_REASON.remittance,
			],
			[
				new toolbox.WERR_INVALID_PARAMETER(
					"paymentRemittance",
					"locked by script conforming to BRC-29",
				),
				UNREADABLE_REASON.remittance,
			],
			[invalidStatus, UNREADABLE_REASON.refused],
			[
				new toolbox.WERR_INVALID_PARAMETER(
					"tx",
					"target transaction of internalizeAction has invalid status failed.",
				),
				UNREADABLE_REASON.refused,
			],
			[
				new WERR_REVIEW_ACTIONS(
					[{ txid: "a".repeat(64), status: "doubleSpend" }],
					[],
				),
				UNREADABLE_REASON.refused,
			],
			[
				new toolbox.WERR_REVIEW_ACTIONS(
					[{ txid: "a".repeat(64), status: "invalidTx" }],
					[],
				),
				UNREADABLE_REASON.refused,
			],
		];
		for (const [error, reason] of permanent) {
			assert.equal(permanentRefusalOf(error), reason, String(error));
		}
		const retryable = [
			new Error("fetch failed"),
			// Also what a chain tracker that is down or behind produces.
			new WERR_INVALID_PARAMETER("tx", "valid AtomicBEEF"),
			new toolbox.WERR_INVALID_PARAMETER("tx", "valid AtomicBEEF"),
			new toolbox.WERR_INVALID_PARAMETER(
				"tx",
				"target transaction of internalizeAction is undergoing active changes.",
			),
			new WERR_INVALID_PARAMETER("description", "valid"),
			new WERR_REVIEW_ACTIONS(
				[{ txid: "a".repeat(64), status: "serviceError" }],
				[],
			),
			new toolbox.WERR_INTERNAL("storage down"),
		];
		for (const error of retryable) {
			assert.equal(permanentRefusalOf(error), null, String(error));
		}
	});

	it("leaves a payment the wallet refused for good in the box, logged once per account, not as a failure", async () => {
		const { wallet } = fakeWallet({
			internalize: async () => {
				throw (toolbox.WalletErrorFromJson as (json: unknown) => Error)({
					name: "WERR_INVALID_PARAMETER",
					parameter: "tx",
					message:
						"The tx parameter must be target transaction of internalizeAction has invalid status failed.",
				});
			},
		});
		const boxes = {
			[OWN]: [
				message("refused", await paidTx(1000, "cmVm"), { suffix: "cmVm" }),
			],
		};
		const refusedLogs = (logged: unknown[][]) =>
			peerpayLogs(logged).filter(([label]) =>
				String(label).includes("can't be accepted"),
			).length;
		const run = await sync(boxes, wallet, [OWN]);
		assert.deepEqual(run.acknowledged, []);
		assert.equal(run.result.failed, 0);
		assert.equal(run.outcome.updates[0]?.status, "unreadable");
		assert.equal(run.outcome.updates[0]?.reason, UNREADABLE_REASON.refused);
		assert.equal(refusedLogs(run.logged), 1);
		const again = await sync(boxes, wallet, [OWN]);
		assert.equal(refusedLogs(again.logged), 0);
		const otherChain = await sync(boxes, wallet, [OWN], {
			...ACCOUNT,
			chain: "test",
		});
		assert.equal(refusedLogs(otherChain.logged), 1);
	});

	it("retries a payment whose BEEF the wallet couldn't verify, counted and logged in full", async () => {
		const { wallet } = fakeWallet({
			internalize: async () => {
				throw new toolbox.WERR_INVALID_PARAMETER("tx", "valid AtomicBEEF");
			},
		});
		const run = await sync(
			{ [OWN]: [message("unverified", await paidTx())] },
			wallet,
			[OWN],
		);
		assert.deepEqual(run.acknowledged, []);
		assert.equal(run.result.failed, 1);
		assert.equal(run.outcome.updates[0]?.status, "failed");
		assert.equal(run.outcome.updates[0]?.reason, RETRY_REASON.wallet);
		const log = peerpayLogs(run.logged).find(([label]) =>
			String(label).includes("internalize failed"),
		);
		assert.ok(log, "the failure is logged");
		assert.match(
			String((log[1] as { error: unknown }).error),
			/valid AtomicBEEF/,
		);
	});

	it("does not acknowledge a copy whose delivery fee failed, and logs it once", async () => {
		const tx = await paidTx();
		const { wallet, internalized } = fakeWallet();
		const boxes = {
			[OWN]: [{ ...message("fee-1", tx), paymentOutcome: "failed" as const }],
			[EXTRA]: [message("extra-1", tx)],
		};
		const feeLogs = (logged: unknown[][]) =>
			peerpayLogs(logged).filter(([label]) =>
				String(label).includes("delivery-fee"),
			).length;
		const run = await sync(boxes, wallet);
		assert.equal(internalized.length, 1);
		assert.deepEqual(run.acknowledged, [
			{ host: EXTRA, messageIds: ["extra-1"] },
		]);
		assert.equal(run.result.leftOnOwnHost, 1);
		assert.equal(feeLogs(run.logged), 1);
		const again = await sync(boxes, wallet);
		assert.deepEqual(again.acknowledged, [
			{ host: EXTRA, messageIds: ["extra-1"] },
		]);
		assert.equal(feeLogs(again.logged), 0);
	});

	it("treats a box whose client can't be built as unreadable", async () => {
		const { wallet } = fakeWallet();
		const run = await quietConsole(() =>
			syncPeerPayInbox({
				hosts: [OWN],
				clientFor: () => {
					throw new TypeError("bad host");
				},
				wallet,
				record: () => undefined,
				account: ACCOUNT,
			}),
		);
		assert.deepEqual(run.result.unreachableHosts, [OWN]);
		assert.equal(run.result.failed, 1);
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
		// defineProperty, not assignment: another test file may leave `window`
		// defined as read-only (but configurable) on the shared global.
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			writable: true,
			value: {
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

	it("keeps the first-seen time when the server sends no created_at", () => {
		const outcome = {
			listedHosts: [OWN],
			listedKeys: new Set(["k"]),
			unreachableHosts: [],
		};
		const update = { ...record("k", OWN, "failed"), createdAt: null };
		saveInboxSync(scope, {
			...outcome,
			updates: [{ ...update, updatedAt: 1000 }],
		});
		saveInboxSync(scope, {
			...outcome,
			updates: [{ ...update, updatedAt: 9000 }],
		});
		assert.equal(
			loadIncomingPayments(scope).records[0]?.createdAt,
			new Date(1000).toISOString(),
		);
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
