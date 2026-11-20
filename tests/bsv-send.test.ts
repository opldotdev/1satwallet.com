import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { SendBsvInput, SendBsvResponse } from "@1sat/actions";
import type { HandleResolution } from "@1sat/client";
import { PrivateKey, type WalletAction } from "@bsv/sdk";
import {
	checkBsvRecipient,
	formatResolvedHandle,
	HANDLE_MISMATCH,
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

	it("pays the handle typed, and refuses a host that answers for another", async () => {
		const evil = await checkBsvRecipient("@bob@evil.com", "main", {
			resolvePaymentHandle: async () =>
				resolution({ handle: "alice", domain: "1sat.app" }),
		});
		assert.deepEqual(evil, { ok: false, message: HANDLE_MISMATCH });
		const tagged = await checkBsvRecipient("@Bob+Tips@Example.com", "main", {
			resolvePaymentHandle: async () => resolution({ tag: "tips" }),
		});
		assert.equal(
			(tagged as { recipient: { handle: string } }).recipient.handle,
			"@bob+tips@example.com",
		);
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
			checkBsvRecipient("@bob@example.com", chain, {
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
	const base = {
		handle: "@bob@example.com",
		satoshis: 1500,
		reviewed: resolution(),
		chain: "main" as const,
	};
	const same = { resolveHandle: async () => resolution() };

	it("sends the @ form with the memo as the only request", async () => {
		const inputs: SendBsvInput[] = [];
		const outcome = await runHandleSend(
			ctx,
			{ ...base, memo: "  lunch  " },
			{
				...same,
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
			{ ...base, satoshis: 1, memo: "   " },
			{
				...same,
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

	it("refuses, before anything is built, a handle that changed since review", async () => {
		const other = PrivateKey.fromRandom().toPublicKey().toString();
		const cases: [Partial<HandleResolution>, RegExp][] = [
			[
				{ identityKey: other, certificate: { subject: other } },
				/changed since you reviewed/,
			],
			[
				{ messagebox: "https://elsewhere.example.com" },
				/changed since you reviewed/,
			],
			[{ revoked: true }, /changed since you reviewed/],
			[
				{ handle: "alice", domain: "1sat.app" },
				/answered for a different handle/,
			],
		];
		for (const [change, message] of cases) {
			let sent = false;
			const outcome = await runHandleSend(ctx, base, {
				resolveHandle: async () => resolution(change),
				send: async () => {
					sent = true;
					return { txid: "x" };
				},
			});
			assert.equal(outcome.kind, "failed");
			assert.match(outcome.message, message);
			assert.equal(sent, false);
		}
		// The checks run again on the fresh answer: an http mailbox that was
		// reviewed as http can't slip through.
		const http = resolution({ messagebox: "http://messagebox.example.com" });
		const outcome = await runHandleSend(
			ctx,
			{ ...base, reviewed: http },
			{ resolveHandle: async () => http, send: async () => ({ txid: "x" }) },
		);
		assert.match(outcome.message, /isn't https/);
	});

	it("says nothing was sent when the lookup before the send fails", async () => {
		const outcome = await runHandleSend(ctx, base, {
			resolveHandle: async () => {
				throw new TypeError("fetch failed");
			},
			send: async () => ({ txid: "x" }),
		});
		assert.deepEqual(outcome, {
			kind: "failed",
			message:
				"Couldn't reach example.com to look up that handle. Nothing was sent.",
		});
	});

	it("keeps the txid of a payment built but not delivered", async () => {
		const outcome = await runHandleSend(ctx, base, {
			...same,
			send: async (): Promise<SendBsvResponse> => ({
				txid: "cd",
				error: "delivery-failed: 502",
			}),
		});
		assert.equal(outcome.kind, "undelivered");
		assert.equal((outcome as { txid: string }).txid, "cd");
		assert.match(outcome.message, /Waiting to be claimed/);
		assert.equal(ownLogs().length, 1);
	});

	it("says nothing was sent only when createAction never returned", async () => {
		const wallet = (createAction: () => Promise<unknown>) =>
			({ wallet: { createAction } }) as unknown as typeof ctx;
		// sendBsv calls createAction, then fails, with no txid to show for it.
		const viaCreateAction: Parameters<typeof runHandleSend>[2] = {
			...same,
			send: async (c) => {
				try {
					await c.wallet.createAction({ description: "x", outputs: [] });
				} catch (error) {
					return { error: (error as Error).message };
				}
				return { error: "identity key unavailable" };
			},
		};
		const built = await runHandleSend(
			wallet(async () => ({ txid: "t", tx: [1] })),
			base,
			viaCreateAction,
		);
		assert.equal(
			built.message,
			"The payment may have been built. Check Waiting to be claimed before sending again.",
		);
		const refused = await runHandleSend(
			wallet(async () => {
				throw new Error("WERR_INSUFFICIENT_FUNDS: Insufficient funds");
			}),
			base,
			viaCreateAction,
		);
		assert.match(
			refused.message,
			/not have enough spendable BSV.*Nothing was sent/,
		);
		const before = await runHandleSend(
			wallet(async () => ({})),
			base,
			{ ...same, send: async () => ({ error: "something odd" }) },
		);
		assert.equal(
			before.message,
			"The payment couldn't be sent. Nothing was sent. Try again.",
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
