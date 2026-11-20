import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { SendBsvInput, SendBsvResponse } from "@1sat/actions";
import type { HandleResolution } from "@1sat/client";
import { PrivateKey, type WalletAction } from "@bsv/sdk";
import {
	checkBsvRecipient,
	formatResolvedHandle,
	HANDLE_SEND_EXPIRY_LABEL,
	handleRefusal,
	isPendingHandleSend,
	listPendingHandleSends,
	PAYMAIL_REFUSED,
	parseHandlePaymentDescription,
	parseIdentityKeyRecipient,
	runHandleSend,
	runHandleSendCancel,
} from "@/lib/wallet/bsv-send";

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

const key = PrivateKey.fromRandom().toPublicKey().toString();
const resolution = (
	over: Partial<HandleResolution> = {},
): HandleResolution => ({
	metanetHandles: "1.0",
	handle: "bob",
	domain: "example.com",
	identityKey: key,
	certificate: { subject: key },
	messagebox: "https://messagebox.example.com",
	ttl: 60,
	revoked: false,
	...over,
});
const ctx = { wallet: {} } as unknown as Parameters<typeof runHandleSend>[0];

describe("recipient parsing", () => {
	it("takes an identity key, as typed or as a peerpay link", () => {
		assert.equal(parseIdentityKeyRecipient(key.toUpperCase()), key);
		assert.equal(parseIdentityKeyRecipient(` peerpay:${key} `), key);
		assert.equal(parseIdentityKeyRecipient(`04${key.slice(2)}`), null);
		assert.equal(parseIdentityKeyRecipient("bob@example.com"), null);
	});

	it("formats a resolution in the @ form, with its tag", () => {
		assert.equal(formatResolvedHandle(resolution()), "@bob@example.com");
		assert.equal(
			formatResolvedHandle(resolution({ tag: "tips" })),
			"@bob+tips@example.com",
		);
	});
});

describe("checkBsvRecipient", () => {
	it("checks an address against the account's chain", async () => {
		const main = PrivateKey.fromRandom().toAddress("mainnet");
		assert.deepEqual(await checkBsvRecipient(main, "main"), {
			ok: true,
			recipient: { kind: "address", address: main },
		});
		const check = await checkBsvRecipient(main, "test");
		assert.equal(check.ok, false);
		assert.match(
			(check as { message: string }).message,
			/testnet BSV address, a handle like @name@domain, or an identity key/,
		);
	});

	it("takes an identity key as a PeerPay recipient", async () => {
		assert.deepEqual(await checkBsvRecipient(`peerpay:${key}`, "main"), {
			ok: true,
			recipient: { kind: "identity", identityKey: key },
		});
	});

	it("resolves a handle and keeps the resolution for review", async () => {
		const asked: string[] = [];
		const check = await checkBsvRecipient(" @Bob@Example.com ", "main", {
			resolvePaymentHandle: async (r) => {
				asked.push(r);
				return resolution();
			},
		});
		assert.deepEqual(asked, ["@Bob@Example.com"]);
		assert.deepEqual(check, {
			ok: true,
			recipient: {
				kind: "handle",
				handle: "@bob@example.com",
				resolution: resolution(),
			},
		});
	});

	it("refuses a bare name@domain whose domain offers no handles (no paymail)", async () => {
		const check = await checkBsvRecipient("bob@example.com", "main", {
			resolvePaymentHandle: async () => undefined,
		});
		assert.deepEqual(check, { ok: false, message: PAYMAIL_REFUSED });
	});

	it("explains a failed lookup and logs it in full", async () => {
		const check = await checkBsvRecipient("@nobody@example.com", "main", {
			resolvePaymentHandle: async () => {
				throw new Error("resolve nobody@example.com failed: 404");
			},
		});
		assert.deepEqual(check, {
			ok: false,
			message: "No handle @nobody@example.com was found.",
		});
		assert.equal(ownLogs().length, 1);
		const unreachable = await checkBsvRecipient("@bob@down.example", "main", {
			resolvePaymentHandle: async () => {
				throw new TypeError("fetch failed");
			},
		});
		assert.deepEqual(unreachable, {
			ok: false,
			message: "Couldn't reach down.example to look up that handle.",
		});
	});

	it("refuses a revoked handle, an http mailbox and the other chain's handle", async () => {
		const check = (r: HandleResolution, chain: "main" | "test") =>
			checkBsvRecipient("@bob@x.com", chain, {
				resolvePaymentHandle: async () => r,
			});
		assert.match(
			(
				(await check(resolution({ revoked: true }), "main")) as {
					message: string;
				}
			).message,
			/revoked/,
		);
		assert.match(
			(
				(await check(
					resolution({ messagebox: "http://messagebox.example.com" }),
					"main",
				)) as { message: string }
			).message,
			/isn't https/,
		);
		assert.equal(
			handleRefusal(resolution({ domain: "testnet.1sat.app" }), "main"),
			"This handle is on Testnet and this account is on Mainnet, so nothing can be sent to it.",
		);
		assert.equal(
			handleRefusal(resolution({ domain: "1sat.app" }), "test"),
			"This handle is on Mainnet and this account is on Testnet, so nothing can be sent to it.",
		);
		assert.equal(
			handleRefusal(resolution({ domain: "1sat.app" }), "main"),
			null,
		);
	});
});

describe("runHandleSend", () => {
	it("sends the @ form with the memo as the only request", async () => {
		const inputs: SendBsvInput[] = [];
		const outcome = await runHandleSend(
			ctx,
			{ handle: "@bob@example.com", satoshis: 1500, memo: "  lunch  " },
			{
				send: async (_c, input) => {
					inputs.push(input);
					return { txid: "ab", delivered: "envelope", messageId: "m" };
				},
			},
		);
		assert.deepEqual(inputs, [
			{
				requests: [
					{ handle: "@bob@example.com", satoshis: 1500, memo: "lunch" },
				],
			},
		]);
		assert.deepEqual(outcome, {
			kind: "sent",
			txid: "ab",
			message:
				"Delivered to @bob@example.com's mailbox. They receive it when their wallet next syncs.",
		});
	});

	it("leaves an empty memo out", async () => {
		const inputs: SendBsvInput[] = [];
		await runHandleSend(
			ctx,
			{ handle: "@bob@example.com", satoshis: 1, memo: "   " },
			{
				send: async (_c, input) => {
					inputs.push(input);
					return { txid: "ab" };
				},
			},
		);
		assert.deepEqual(inputs[0].requests[0], {
			handle: "@bob@example.com",
			satoshis: 1,
		});
	});

	it("keeps the txid of a payment built but not delivered", async () => {
		const outcome = await runHandleSend(
			ctx,
			{ handle: "@bob@example.com", satoshis: 1 },
			{
				send: async (): Promise<SendBsvResponse> => ({
					txid: "cd",
					error: "delivery-failed: 502",
				}),
			},
		);
		assert.equal(outcome.kind, "undelivered");
		assert.equal((outcome as { txid: string }).txid, "cd");
		assert.match(outcome.message, /Waiting to be claimed/);
		assert.equal(ownLogs().length, 1);
	});

	it("says nothing was sent only for failures before the build", async () => {
		const fail = (error: string) =>
			runHandleSend(
				ctx,
				{ handle: "@bob@example.com", satoshis: 1 },
				{ send: async () => ({ error }) },
			);
		assert.equal(
			(await fail("WERR_INSUFFICIENT_FUNDS: Insufficient funds")).message,
			"The wallet does not have enough spendable BSV for this amount and its fee.",
		);
		assert.equal(
			(await fail("example.com does not offer handle resolution")).message,
			"That domain doesn't offer handles. Check the handle.",
		);
		assert.equal(
			(await fail("something after the build")).message,
			"The payment may have been built. Check Waiting to be claimed before sending again.",
		);
	});
});

describe("handle payments waiting to be claimed", () => {
	const action = (over: Partial<WalletAction>): WalletAction =>
		({
			txid: "t1",
			satoshis: -1600,
			status: "nosend",
			isOutgoing: true,
			description: "Payment to bob@example.com",
			labels: [HANDLE_SEND_EXPIRY_LABEL],
			version: 1,
			lockTime: 0,
			outputs: [
				{
					outputIndex: 0,
					satoshis: 1500,
					spendable: false,
					outputDescription: "Payment to handle",
					basket: "",
					tags: [],
				},
			],
			...over,
		}) as WalletAction;

	it("reads the handle back from the description, unless it was cut", () => {
		assert.equal(
			parseHandlePaymentDescription("Payment to bob@example.com"),
			"@bob@example.com",
		);
		const cut = `Payment to ${"a".repeat(30)}@example.com`.slice(0, 50);
		assert.equal(parseHandlePaymentDescription(cut), null);
		assert.equal(parseHandlePaymentDescription("Send 1 payment(s)"), null);
	});

	it("is only a nosend handle payment, never a 1Color send", () => {
		assert.equal(isPendingHandleSend(action({})), true);
		assert.equal(isPendingHandleSend(action({ status: "completed" })), false);
		assert.equal(isPendingHandleSend(action({ labels: [] })), false);
		assert.equal(
			isPendingHandleSend(
				action({
					labels: [HANDLE_SEND_EXPIRY_LABEL, "1color send abc def"],
				}),
			),
			false,
		);
	});

	it("lists them newest first with amount and handle", async () => {
		const actions = [
			action({ txid: "old" }),
			action({ txid: "done", status: "completed" }),
			action({ txid: "new", description: "Payment to carol@example.com" }),
		];
		const wallet = {
			listActions: async (args: { limit?: number; offset?: number }) => ({
				totalActions: actions.length,
				actions: actions.slice(
					args.offset ?? 0,
					(args.offset ?? 0) + (args.limit ?? actions.length),
				),
			}),
		};
		const { sends, truncated } = await listPendingHandleSends(wallet as never);
		assert.equal(truncated, false);
		assert.deepEqual(sends, [
			{ txid: "new", satoshis: 1500, handle: "@carol@example.com" },
			{ txid: "old", satoshis: 1500, handle: "@bob@example.com" },
		]);
	});

	it("cancels by txid and reports what the wallet said", async () => {
		const aborted: string[] = [];
		const wallet = {
			abortAction: async ({ reference }: { reference: string }) => {
				aborted.push(reference);
				return { aborted: true as const };
			},
		};
		const outcome = await runHandleSendCancel(wallet as never, {
			txid: "t1",
			handle: "@bob@example.com",
		});
		assert.deepEqual(aborted, ["t1"]);
		assert.equal(outcome.kind, "requested");
		assert.match(outcome.message, /unless @bob@example.com claimed them/);

		const settled = await runHandleSendCancel(
			{
				abortAction: async () => {
					throw new Error(
						"The reference parameter must be an inprocess, outgoing action",
					);
				},
			} as never,
			{ txid: "t1", handle: null },
		);
		assert.equal(settled.kind, "refused");
		assert.equal(ownLogs().length, 1);
	});
});
