import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
import type { IncomingPaymentRecord } from "@/lib/wallet/incoming-payments";
import {
	combineInboxResults,
	type InboxClient,
	type InboxPayment,
	paymentKeyOf,
	peerPayInternalizer,
	peerPayPaymentOf,
	syncPeerPayInbox,
} from "@/lib/wallet/peerpay-inbox";

const OWN = "https://messagebox.1sat.app";
const EXTRA = "https://messagebox.bsvblockchain.tech";
const sender = PrivateKey.fromRandom().toPublicKey().toString();

function paymentTx(satoshis: number): number[] {
	const tx = new Transaction();
	tx.addOutput({
		lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
		satoshis,
	});
	return tx.toAtomicBEEF(true);
}

function peerPayMessage(
	messageId: string,
	transaction: number[],
	amount = 1000,
): PeerMessage {
	return {
		messageId,
		sender,
		created_at: "2026-11-16T10:00:00.000Z",
		updated_at: "2026-11-16T10:00:00.000Z",
		body: JSON.stringify({
			customInstructions: {
				derivationPrefix: "cHJl",
				derivationSuffix: "c3Vm",
			},
			transaction,
			amount,
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
	const clientFor = (host: string): InboxClient => ({
		async listMessages(args) {
			assert.equal(args.host, host);
			assert.equal(args.messageBox, "payment_inbox");
			const box = boxes[host];
			if (box instanceof Error) throw box;
			return box ?? [];
		},
		async acknowledgeMessage({ messageIds, host: ackHost }) {
			acknowledged.push({ host: ackHost, messageIds });
			return "success";
		},
	});
	return { acknowledged, clientFor };
}

function quietConsole<T>(run: () => Promise<T>) {
	const original = console.error;
	const logged: unknown[][] = [];
	console.error = (...args: unknown[]) => {
		logged.push(args);
	};
	return run()
		.then((result) => ({ result, logged }))
		.finally(() => {
			console.error = original;
		});
}

describe("PeerPay inbox", () => {
	it("reads the own box first, then the chain's extra read boxes", () => {
		assert.deepEqual(messageboxReadHostsOf("main"), [OWN, EXTRA]);
		assert.deepEqual(messageboxReadHostsOf("test"), [
			"https://testnet.messagebox.1sat.app",
		]);
	});

	it("reads PeerPay tokens and leaves paymail messages to syncMessages", () => {
		const tx = paymentTx(1000);
		const payment = peerPayPaymentOf(peerPayMessage("m1", tx), OWN);
		assert.equal(payment?.token.amount, 1000);
		assert.equal(payment?.token.outputIndex, 0);
		assert.equal(payment?.createdAt, "2026-11-16T10:00:00.000Z");
		assert.equal(peerPayPaymentOf(paymailMessage, OWN), null);
		assert.equal(
			peerPayPaymentOf({ ...peerPayMessage("m2", tx), sender: "nope" }, OWN),
			null,
		);
	});

	it("takes a payment found on two boxes once and acknowledges both copies on their own box", async () => {
		const tx = paymentTx(1000);
		const { acknowledged, clientFor } = fakeBoxes({
			[OWN]: [peerPayMessage("own-1", tx), paymailMessage],
			[EXTRA]: [
				peerPayMessage("extra-9", tx),
				peerPayMessage("extra-2", paymentTx(500), 500),
			],
		});
		const internalized: InboxPayment[] = [];
		const recorded: IncomingPaymentRecord[] = [];
		const result = await syncPeerPayInbox({
			hosts: [OWN, EXTRA],
			clientFor,
			internalize: async (payment) => {
				internalized.push(payment);
			},
			received: new Set(),
			record: (records) => recorded.push(...records),
			now: () => 1,
		});

		assert.deepEqual(
			internalized.map((p) => [p.host, p.messageId]),
			[
				[OWN, "own-1"],
				[EXTRA, "extra-2"],
			],
		);
		assert.deepEqual(acknowledged, [
			{ host: OWN, messageIds: ["own-1"] },
			{ host: EXTRA, messageIds: ["extra-9", "extra-2"] },
		]);
		assert.deepEqual(result, { processed: 2, failed: 0, leftOnOwnHost: 0 });
		assert.deepEqual(
			recorded.map((r) => [r.messageId, r.host, r.status, r.satoshis]),
			[
				["own-1", OWN, "received", 1000],
				["extra-2", EXTRA, "received", 500],
			],
		);
	});

	it("does not dedupe the same output from different senders", () => {
		const tx = paymentTx(1000);
		const a = peerPayPaymentOf(peerPayMessage("a", tx), OWN);
		const other = PrivateKey.fromRandom().toPublicKey().toString();
		const b = peerPayPaymentOf(
			{ ...peerPayMessage("b", tx), sender: other },
			EXTRA,
		);
		assert.ok(a && b);
		assert.notEqual(paymentKeyOf(a), paymentKeyOf(b));
	});

	it("keeps a payment the wallet refused for retry, on every box, and logs the details", async () => {
		const tx = paymentTx(1000);
		const { acknowledged, clientFor } = fakeBoxes({
			[OWN]: [peerPayMessage("own-1", tx)],
			[EXTRA]: [peerPayMessage("extra-1", tx)],
		});
		const recorded: IncomingPaymentRecord[] = [];
		const { result, logged } = await quietConsole(() =>
			syncPeerPayInbox({
				hosts: [OWN, EXTRA],
				clientFor,
				internalize: async () => {
					throw new Error("BRC-29 settlement failed", {
						cause: new Error("Output script does not match"),
					});
				},
				received: new Set(),
				record: (records) => recorded.push(...records),
			}),
		);

		assert.deepEqual(acknowledged, []);
		assert.deepEqual(result, { processed: 0, failed: 1, leftOnOwnHost: 1 });
		assert.equal(recorded[0]?.status, "failed");
		assert.equal(recorded[0]?.reason, "Output script does not match");
		const internalizeLog = logged
			.map(([label, detail]) => [String(label), detail] as const)
			.find(([label]) => label.includes("internalize"));
		assert.ok(internalizeLog, "the failure is logged");
		const detail = internalizeLog[1] as Record<string, unknown>;
		assert.equal(detail.host, OWN);
		assert.equal(detail.messageId, "own-1");
		assert.equal(detail.sender, sender);
		assert.ok(detail.error instanceof Error);

		// The paymail sync fails the same leftover message: counted once.
		assert.deepEqual(combineInboxResults(result, { processed: 0, failed: 1 }), {
			processed: 0,
			failed: 1,
		});
	});

	it("only acknowledges a payment already received", async () => {
		const tx = paymentTx(1000);
		const { acknowledged, clientFor } = fakeBoxes({
			[OWN]: [peerPayMessage("own-1", tx)],
		});
		const key = paymentKeyOf(
			peerPayPaymentOf(peerPayMessage("own-1", tx), OWN) as InboxPayment,
		);
		let calls = 0;
		const result = await syncPeerPayInbox({
			hosts: [OWN],
			clientFor,
			internalize: async () => {
				calls += 1;
			},
			received: new Set([key]),
			record: () => undefined,
		});
		assert.equal(calls, 0);
		assert.deepEqual(acknowledged, [{ host: OWN, messageIds: ["own-1"] }]);
		assert.deepEqual(result, { processed: 0, failed: 0, leftOnOwnHost: 0 });
	});

	it("fails on an unreadable own box but only notes an unreadable extra box", async () => {
		const { clientFor } = fakeBoxes({
			[OWN]: [],
			[EXTRA]: new Error("ECONNREFUSED"),
		});
		const extraDown = await quietConsole(() =>
			syncPeerPayInbox({
				hosts: [OWN, EXTRA],
				clientFor,
				internalize: async () => undefined,
				received: new Set(),
				record: () => undefined,
			}),
		);
		assert.equal(extraDown.result.failed, 0);
		assert.deepEqual(
			extraDown.logged
				.map(([label]) => String(label))
				.filter((label) => label.startsWith("[peerpay]")),
			["[peerpay] list failed"],
		);

		const own = fakeBoxes({ [OWN]: new Error("HTTP 500") });
		const ownDown = await quietConsole(() =>
			syncPeerPayInbox({
				hosts: [OWN],
				clientFor: own.clientFor,
				internalize: async () => undefined,
				received: new Set(),
				record: () => undefined,
			}),
		);
		assert.equal(ownDown.result.failed, 1);
	});

	it("internalizes a token as PeerPayClient does, and reports why one is refused", async () => {
		const recipient = new ProtoWallet(PrivateKey.fromRandom());
		const { publicKey } = await recipient.getPublicKey({
			protocolID: [2, "3241645161d8"],
			keyID: "cHJl c3Vm",
			counterparty: sender,
			forSelf: true,
		});
		const paid = new Transaction();
		paid.addOutput({
			lockingScript: new P2PKH().lock(
				PublicKey.fromString(publicKey).toAddress(),
			),
			satoshis: 1000,
		});
		const requests: unknown[] = [];
		const wallet = {
			getPublicKey: (args: Parameters<WalletInterface["getPublicKey"]>[0]) =>
				recipient.getPublicKey(args),
			internalizeAction: async (args: unknown) => {
				requests.push(args);
				return { accepted: true };
			},
		} as unknown as WalletInterface;
		const internalize = peerPayInternalizer(wallet);
		const ok = peerPayPaymentOf(
			peerPayMessage("m1", paid.toAtomicBEEF(true)),
			OWN,
		) as InboxPayment;
		await internalize(ok);
		assert.equal(requests.length, 1);
		const request = requests[0] as {
			labels: string[];
			outputs: {
				protocol: string;
				paymentRemittance: { senderIdentityKey: string };
			}[];
		};
		assert.deepEqual(request.labels, ["peerpay"]);
		assert.equal(request.outputs[0]?.protocol, "wallet payment");
		assert.equal(
			request.outputs[0]?.paymentRemittance.senderIdentityKey,
			sender,
		);

		const wrongAmount = peerPayPaymentOf(
			peerPayMessage("m2", paid.toAtomicBEEF(true), 999),
			OWN,
		) as InboxPayment;
		await assert.rejects(internalize(wrongAmount), (error: Error) => {
			assert.ok(error.cause instanceof Error, "the SDK's reason is kept");
			return true;
		});
		assert.equal(requests.length, 1, "nothing is internalized");
	});
});
