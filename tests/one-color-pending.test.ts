import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COLOR_SEND_LABEL_PREFIX } from "@1sat/actions";
import type {
	AbortActionArgs,
	ActionStatus,
	ListActionsArgs,
	WalletAction,
} from "@bsv/sdk";
import { ONE_COLOR_SCAN_MAX } from "@/lib/wallet/one-color";
import {
	isPendingOneColorSend,
	listPendingOneColorSends,
	oneColorSendPlanLabels,
	parseOneColorSendDescription,
	runOneColorCancel,
} from "@/lib/wallet/one-color-actions";

const ASSET = `${"ab".repeat(32)}_0`;
const OTHER = `${"cd".repeat(32)}_0`;
const SEND_LABEL = `${COLOR_SEND_LABEL_PREFIX}${"01".repeat(16)} ${"02".repeat(16)}`;
const EXPIRY_LABEL = "p nosend expiry seconds 31536000";

const txidOf = (n: number) => n.toString(16).padStart(64, "0");

const action = (
	n: number,
	{
		status = "nosend",
		labels = [...oneColorSendPlanLabels(ASSET), SEND_LABEL, EXPIRY_LABEL],
		description = "Send 60 1Color tokens to @deggen+conf@lkup.net",
	}: { status?: ActionStatus; labels?: string[]; description?: string } = {},
): WalletAction => ({
	txid: txidOf(n),
	satoshis: 0,
	status,
	isOutgoing: true,
	description,
	labels,
	version: 1,
	lockTime: 0,
});

/** `listActions` over `actions` in storage order, oldest first. */
function fakeWallet(actions: WalletAction[]) {
	const calls: ListActionsArgs[] = [];
	return {
		calls,
		wallet: {
			listActions: async (args: ListActionsArgs) => {
				calls.push(args);
				const offset = args.offset ?? 0;
				const limit = args.limit ?? 10;
				return {
					totalActions: actions.length,
					actions: actions.slice(offset, offset + limit),
				};
			},
		},
	};
}

describe("parseOneColorSendDescription (iOS parseSendDescription)", () => {
	it("reads the amount and handle send1Color writes", () => {
		assert.deepEqual(
			parseOneColorSendDescription(
				"Send 18446744073709551615 1Color tokens to @deggen+conf@lkup.net",
			),
			{ amount: 18_446_744_073_709_551_615n, handle: "@deggen+conf@lkup.net" },
		);
	});

	it("is null for any other text", () => {
		for (const text of [
			"",
			"Send 0 1Color tokens to @a@b.c",
			"Send 5 1Color tokens to a@b.c",
			"Send 5 1Color tokens to @a@b@c",
			"Send x 1Color tokens to @a@b.c",
			"Received 5 1Color tokens",
		]) {
			assert.equal(parseOneColorSendDescription(text), null, text);
		}
	});
});

describe("isPendingOneColorSend", () => {
	const plan = oneColorSendPlanLabels(ASSET);

	it("needs status nosend", () => {
		assert.ok(isPendingOneColorSend(action(1), plan));
		for (const status of [
			"completed",
			"unproven",
			"sending",
			"failed",
			"unsigned",
			"nonfinal",
			"unprocessed",
		] as ActionStatus[]) {
			assert.equal(isPendingOneColorSend(action(1, { status }), plan), false);
		}
	});

	it("needs the 1color send label and this asset's transfer plan", () => {
		assert.equal(
			isPendingOneColorSend(
				action(1, { labels: [...plan, EXPIRY_LABEL] }),
				plan,
			),
			false,
		);
		assert.equal(
			isPendingOneColorSend(
				action(1, {
					labels: [...oneColorSendPlanLabels(OTHER), SEND_LABEL],
				}),
				plan,
			),
			false,
		);
		assert.equal(
			isPendingOneColorSend({ ...action(1), labels: undefined }, plan),
			false,
		);
	});
});

describe("listPendingOneColorSends", () => {
	it("lists this asset's nosend sends newest first, reading labels", async () => {
		const actions = [
			action(1),
			action(2, { status: "completed" }),
			action(3, { labels: [...oneColorSendPlanLabels(OTHER), SEND_LABEL] }),
			action(4, { description: "something else" }),
			action(5, { labels: ["inbound"] }),
		];
		const { wallet, calls } = fakeWallet(actions);
		const result = await listPendingOneColorSends(wallet, ASSET);
		assert.deepEqual(result, {
			sends: [
				{ txid: txidOf(4), amount: null, handle: null },
				{ txid: txidOf(1), amount: 60n, handle: "@deggen+conf@lkup.net" },
			],
			truncated: false,
		});
		// Label queries are exact-match, so nothing is filtered by label in storage.
		for (const call of calls) assert.deepEqual(call.labels, []);
		assert.equal(calls.at(-1)?.includeLabels, true);
	});

	it("says when the scan cap left older actions unread", async () => {
		const actions = Array.from({ length: ONE_COLOR_SCAN_MAX + 1 }, (_, i) =>
			action(i + 1, { status: "completed" }),
		);
		const result = await listPendingOneColorSends(
			fakeWallet(actions).wallet,
			ASSET,
		);
		assert.deepEqual(result, { sends: [], truncated: true });
	});
});

describe("runOneColorCancel", () => {
	const harness = (
		abort: (args: AbortActionArgs) => Promise<{ aborted: boolean }>,
	) => {
		const steps: string[] = [];
		const aborts: AbortActionArgs[] = [];
		const logged: [string, unknown, { txid?: string } | undefined][] = [];
		return {
			steps,
			aborts,
			logged,
			ctx: {
				wallet: {
					abortAction: async (args: AbortActionArgs) => {
						steps.push("abort");
						aborts.push(args);
						return abort(args);
					},
				},
			} as unknown as Parameters<typeof runOneColorCancel>[0],
			options: {
				refresh: async () => {
					steps.push("refresh");
				},
				log: (
					operation: string,
					error: unknown,
					details?: { txid?: string },
				) => {
					logged.push([operation, error, details]);
				},
			},
		};
	};
	const send = { txid: txidOf(7), handle: "@deggen@lkup.net" };

	it("aborts by the send's txid, then refreshes", async () => {
		const { steps, aborts, ctx, options, logged } = harness(async () => ({
			aborted: true,
		}));
		const outcome = await runOneColorCancel(ctx, send, options);
		assert.deepEqual(aborts, [{ reference: txidOf(7) }]);
		assert.deepEqual(steps, ["abort", "refresh"]);
		assert.equal(outcome.kind, "requested");
		assert.match(
			outcome.message,
			/unless @deggen@lkup\.net claimed them first/,
		);
		assert.deepEqual(logged, []);
	});

	it("reports aborted: false as already on the network", async () => {
		const { ctx, options } = harness(async () => ({ aborted: false }));
		assert.deepEqual(await runOneColorCancel(ctx, send, options), {
			kind: "refused",
			message: "This send is already on the network, so it can't be cancelled.",
		});
	});

	it("surfaces an abort failure with the txid logged, and still refreshes", async () => {
		const failure = new Error(
			"WERR_INVALID_PARAMETER: reference must be an inprocess, outgoing action",
		);
		const { steps, ctx, options, logged } = harness(async () => {
			throw failure;
		});
		const outcome = await runOneColorCancel(ctx, send, options);
		assert.deepEqual(outcome, {
			kind: "failed",
			message: "The send couldn't be cancelled. Try again.",
		});
		assert.deepEqual(steps, ["abort", "refresh"]);
		assert.deepEqual(logged, [["send-cancel", failure, { txid: txidOf(7) }]]);
	});
});
