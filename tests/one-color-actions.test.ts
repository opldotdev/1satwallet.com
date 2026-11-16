import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type {
	Deploy1ColorInput,
	OneSatContext,
	Send1ColorInput,
	Send1ColorResult,
} from "@1sat/actions";
import { HttpError } from "@1sat/client";
import { OneColor } from "@1sat/templates";
import {
	ColorConsentDeclinedError,
	ColorPlan,
	ISSUE,
} from "@bsv/color-permission-module";
import {
	type CreateActionArgs,
	LockingScript,
	PrivateKey,
	ProtoWallet,
	type WalletInterface,
} from "@bsv/sdk";
import {
	describeOneColorDeployFailure,
	describeOneColorSendFailure,
	executeOneColorDeploy,
	executeOneColorSend,
	formatOneColorAmount,
	isPendingOneColorSend,
	normalizeHandle,
	ONE_COLOR_MAX_AMOUNT,
	ONE_COLOR_MAX_ICON_BYTES,
	type OneColorActionSet,
	oneColorDeployFailureMessage,
	oneColorSendAmountError,
	oneColorSendPlanLabels,
	oneColorSupplyError,
	parseOneColorAmount,
	parseOneColorSendDescription,
	runOneColorDeploy,
	runOneColorSend,
} from "@/lib/wallet/one-color-actions";

const ctx = { chain: "test" } as unknown as OneSatContext;
const txid = "ab".repeat(32);

function recordingActions(
	result: Awaited<ReturnType<OneColorActionSet["deploy"]>> = {
		txid,
		tx: [1],
		assetId: `${txid}_0`,
	},
) {
	const calls: Deploy1ColorInput[] = [];
	const actions: Pick<OneColorActionSet, "deploy"> = {
		deploy: async (_ctx, input) => {
			calls.push(input);
			return result;
		},
	};
	return { calls, actions };
}

describe("1Color amounts", () => {
	it("parses display amounts into exact atomic units at 0, 8 and 18 decimals", () => {
		assert.equal(parseOneColorAmount("21000000", 0), 21_000_000n);
		assert.equal(parseOneColorAmount("1.5", 8), 150_000_000n);
		assert.equal(parseOneColorAmount("1", 18), 10n ** 18n);
		assert.equal(
			parseOneColorAmount("9007199254740993", 0),
			9_007_199_254_740_993n,
		);
		assert.equal(
			parseOneColorAmount(ONE_COLOR_MAX_AMOUNT.toString(), 0),
			ONE_COLOR_MAX_AMOUNT,
		);
	});

	it("refuses zero, malformed, too many places and above 2^64-1", () => {
		for (const invalid of ["", "0", "-1", "1e3", "1.001"]) {
			assert.equal(parseOneColorAmount(invalid, 2), null, invalid);
		}
		assert.equal(
			parseOneColorAmount((ONE_COLOR_MAX_AMOUNT + 1n).toString(), 0),
			null,
		);
		assert.equal(parseOneColorAmount("1", 19), null);
	});

	it("formats atomic units exactly", () => {
		assert.equal(formatOneColorAmount(150_000_000n, 8), "1.5");
		assert.equal(formatOneColorAmount("1", 18), "0.000000000000000001");
	});
});

describe("executeOneColorDeploy", () => {
	it("sends the exact input for a fixed-supply deploy", async () => {
		const { calls, actions } = recordingActions();
		const result = await executeOneColorDeploy(
			ctx,
			{ amount: 2_100_000_000_000_000n, decimals: 8, symbol: "GOLD" },
			actions,
		);
		assert.deepEqual(calls, [
			{ amount: "2100000000000000", decimals: 8, symbol: "GOLD" },
		]);
		assert.equal(result.assetId, `${txid}_0`);
		assert.equal(result.error, undefined);
	});

	it("sends amount '0' for an authority deploy and leaves out absent fields", async () => {
		const { calls, actions } = recordingActions();
		await executeOneColorDeploy(ctx, { amount: 0n, decimals: 0 }, actions);
		assert.deepEqual(calls, [{ amount: "0", decimals: 0 }]);
	});

	it("passes icon bytes as an array", async () => {
		const { calls, actions } = recordingActions();
		await executeOneColorDeploy(
			ctx,
			{
				amount: 1n,
				decimals: 0,
				icon: { mediaType: "image/png", bytes: Uint8Array.of(0x89, 0x50) },
			},
			actions,
		);
		assert.deepEqual(calls[0].icon, {
			mediaType: "image/png",
			bytes: [0x89, 0x50],
		});
		assert.ok(Array.isArray(calls[0].icon?.bytes));
	});

	it("refuses bad input before the wallet is asked", async () => {
		const cases: [Parameters<typeof executeOneColorDeploy>[1], string][] = [
			[{ amount: 1n, decimals: 19 }, "decimals-out-of-range"],
			[{ amount: 1n, decimals: -1 }, "decimals-out-of-range"],
			[{ amount: 1n, decimals: 1.5 }, "decimals-out-of-range"],
			[{ amount: 1n, decimals: Number.NaN }, "decimals-out-of-range"],
			[
				{ amount: ONE_COLOR_MAX_AMOUNT + 1n, decimals: 0 },
				"amount-out-of-range",
			],
			[{ amount: -1n, decimals: 0 }, "amount-out-of-range"],
			[{ amount: 1n, decimals: 0, symbol: "x".repeat(33) }, "symbol-invalid"],
			[{ amount: 1n, decimals: 0, symbol: "" }, "symbol-invalid"],
			[{ amount: 1n, decimals: 0, symbol: "A\nB" }, "symbol-invalid"],
			[{ amount: 1n, decimals: 0, symbol: "A​B" }, "symbol-invalid"],
			[{ amount: 1n, decimals: 0, symbol: "A‮B" }, "symbol-invalid"],
			[
				{
					amount: 1n,
					decimals: 0,
					icon: {
						mediaType: "image/png",
						bytes: new Uint8Array(ONE_COLOR_MAX_ICON_BYTES + 1),
					},
				},
				"icon-too-large",
			],
			[
				{
					amount: 1n,
					decimals: 0,
					icon: { mediaType: "text/plain", bytes: [1] },
				},
				"icon-not-image",
			],
			[
				{
					amount: 1n,
					decimals: 0,
					icon: { mediaType: "image/png", bytes: [] },
				},
				"icon-not-image",
			],
		];
		for (const [input, expected] of cases) {
			const { calls, actions } = recordingActions();
			const result = await executeOneColorDeploy(ctx, input, actions);
			assert.equal(
				result.error,
				expected,
				JSON.stringify(String(input.symbol)),
			);
			assert.equal(calls.length, 0);
		}
	});

	it("accepts an icon exactly at the cap", async () => {
		const { calls, actions } = recordingActions();
		const result = await executeOneColorDeploy(
			ctx,
			{
				amount: 1n,
				decimals: 0,
				icon: {
					mediaType: "image/webp",
					bytes: new Uint8Array(ONE_COLOR_MAX_ICON_BYTES),
				},
			},
			actions,
		);
		assert.equal(result.error, undefined);
		assert.equal(calls[0].icon?.bytes.length, ONE_COLOR_MAX_ICON_BYTES);
	});

	it("reports no-transaction when the action returns no txid", async () => {
		const { actions } = recordingActions({});
		const result = await executeOneColorDeploy(
			ctx,
			{ amount: 1n, decimals: 0 },
			actions,
		);
		assert.deepEqual(result, { error: "no-transaction" });
	});

	it("passes the action's own error through", async () => {
		const { actions } = recordingActions({
			error: "Insufficient funds in the available inputs",
		});
		const result = await executeOneColorDeploy(
			ctx,
			{ amount: 1n, decimals: 0 },
			actions,
		);
		assert.equal(result.error, "Insufficient funds in the available inputs");
	});

	it("runs the SDK deploy as one createAction carrying the ISSUE plan", async () => {
		const proto = new ProtoWallet(PrivateKey.fromHex("01".repeat(32)));
		const created: CreateActionArgs[] = [];
		const wallet = {
			getPublicKey: (args: Parameters<WalletInterface["getPublicKey"]>[0]) =>
				proto.getPublicKey(args),
			createAction: async (args: CreateActionArgs) => {
				created.push(args);
				return {};
			},
		} as unknown as WalletInterface;
		const result = await executeOneColorDeploy(
			{ wallet, chain: "test" } as unknown as OneSatContext,
			{
				amount: 500n,
				decimals: 2,
				symbol: "TEST",
				icon: { mediaType: "image/png", bytes: Uint8Array.of(1, 2, 3) },
			},
		);
		// The fake returns no transaction, which the SDK reports itself.
		assert.deepEqual(result, { error: "no-transaction" });
		assert.equal(created.length, 1);
		const args = created[0];
		assert.deepEqual(args.options, { randomizeOutputs: false });
		assert.equal(args.inputs, undefined);
		const plan = ColorPlan.fromLabels(args.labels);
		assert.deepEqual(plan?.operations, [
			{ assetId: ISSUE, operation: "deploy-fixed" },
		]);
		const output = args.outputs?.[0];
		assert.equal(output?.satoshis, 1);
		const token = OneColor.decode(
			LockingScript.fromHex(output?.lockingScript ?? ""),
		);
		assert.equal(token?.role, "deploy");
		assert.equal(token?.amount, 500n);
		assert.deepEqual(token?.metadata, {
			sym: "TEST",
			dec: 2,
			icon: { mediaType: "image/png", bytes: Uint8Array.of(1, 2, 3) },
		});
	});
});

describe("oneColorSupplyError", () => {
	it("names the largest supply when the number parses but is over 2^64-1", () => {
		assert.equal(
			oneColorSupplyError("18446744073709551616", 0),
			"The supply can be at most 18446744073709551615 with 0 decimals.",
		);
		assert.equal(
			oneColorSupplyError("184467440737.09551616", 8),
			"The supply can be at most 184467440737.09551615 with 8 decimals.",
		);
	});

	it("keeps the places message for malformed or over-precise supplies", () => {
		assert.match(oneColorSupplyError("1.001", 2), /at most 2 decimals/);
		assert.match(oneColorSupplyError("0", 2), /positive fixed supply/);
		assert.match(oneColorSupplyError("1", 19), /0 through 18/);
	});
});

describe("describeOneColorDeployFailure", () => {
	it("says nothing was sent only for the module's own consent refusal", () => {
		for (const error of [
			new ColorConsentDeclinedError("createAction"),
			new Error(
				"[ColorConsentDeclinedError] BRC-207: the user declined the createAction request",
			),
			"BRC-207: the user declined the createAction request",
		]) {
			assert.deepEqual(describeOneColorDeployFailure(error), {
				message: "The wallet declined the deploy. Nothing was sent.",
				mayHaveBeenSent: false,
			});
		}
	});

	it("treats overlay and other post-sign failures as possibly deployed", () => {
		for (const error of [
			new HttpError(502, "Bad Gateway"),
			new TypeError("Failed to fetch"),
			new Error("transaction rejected"),
			new Error("User denied the request"),
			new Error("Request cancelled"),
			new Error("no-transaction"),
			new Error("something unexpected"),
		]) {
			const failure = describeOneColorDeployFailure(error);
			assert.equal(failure.mayHaveBeenSent, true, error.message);
			assert.match(failure.message, /may have been deployed/, error.message);
			assert.doesNotMatch(failure.message, /Nothing was sent/, error.message);
		}
	});

	it("maps checks made before signing to specific messages", () => {
		const cases: [string, RegExp][] = [
			["decimals-out-of-range", /0 through 18/],
			["dec must be an integer 0-18", /0 through 18/],
			["amount-out-of-range", /2\^64-1/],
			["amount must be between 0 and 2^64-1", /2\^64-1/],
			["symbol-invalid", /at most 32 characters/],
			["icon-too-large", /at most 100 KB/],
			["icon-not-image", /image file/],
			[
				"WERR_INSUFFICIENT_FUNDS: Insufficient funds in the available inputs",
				/Not enough BSV/,
			],
		];
		for (const [error, expected] of cases) {
			const failure = describeOneColorDeployFailure(new Error(error));
			assert.match(failure.message, expected, error);
			assert.equal(failure.mayHaveBeenSent, false, error);
			assert.equal(
				oneColorDeployFailureMessage(new Error(error)),
				failure.message,
			);
			assert.ok(failure.message.length < 160, error);
		}
	});
});

describe("runOneColorDeploy", () => {
	const harness = (
		deploy: OneColorActionSet["deploy"],
		refreshFails = false,
	) => {
		const steps: string[] = [];
		const logged: [string, unknown][] = [];
		return {
			steps,
			logged,
			options: {
				actions: {
					deploy: async (...args: Parameters<OneColorActionSet["deploy"]>) => {
						steps.push("deploy");
						return deploy(...args);
					},
				},
				refresh: async () => {
					steps.push("refresh");
					if (refreshFails) throw new Error("listOutputs failed");
				},
				log: (operation: string, error: unknown) => {
					logged.push([operation, error]);
				},
			},
		};
	};

	it("re-reads holdings after a post-sign failure and logs the full error", async () => {
		const { steps, logged, options } = harness(async () => ({
			error: "Bad Gateway",
		}));
		const outcome = await runOneColorDeploy(
			ctx,
			{ amount: 5n, decimals: 0 },
			options,
		);
		assert.deepEqual(steps, ["deploy", "refresh"]);
		assert.equal(outcome.ok, false);
		assert.equal(!outcome.ok && outcome.mayHaveBeenSent, true);
		assert.equal(logged.length, 1);
		assert.equal(logged[0][0], "deploy-fixed");
		assert.equal((logged[0][1] as Error).message, "Bad Gateway");
	});

	it("still re-reads when the action throws, and logs a failed re-read", async () => {
		const { steps, logged, options } = harness(async () => {
			throw new TypeError("Failed to fetch");
		}, true);
		const outcome = await runOneColorDeploy(
			ctx,
			{ amount: 0n, decimals: 0 },
			options,
		);
		assert.deepEqual(steps, ["deploy", "refresh"]);
		assert.equal(!outcome.ok && outcome.mayHaveBeenSent, true);
		assert.deepEqual(
			logged.map(([operation]) => operation),
			["deploy-authority", "holdings-refresh"],
		);
	});

	it("reports a consent refusal as not sent", async () => {
		const { options } = harness(async () => ({
			error: new ColorConsentDeclinedError("createAction").message,
		}));
		const outcome = await runOneColorDeploy(
			ctx,
			{ amount: 5n, decimals: 0 },
			options,
		);
		assert.deepEqual(outcome, {
			ok: false,
			message: "The wallet declined the deploy. Nothing was sent.",
			mayHaveBeenSent: false,
		});
	});

	it("re-reads holdings and returns the asset id on success", async () => {
		const { steps, logged, options } = harness(async () => ({
			txid,
			tx: [1],
			assetId: `${txid}_0`,
		}));
		const outcome = await runOneColorDeploy(
			ctx,
			{ amount: 5n, decimals: 0 },
			options,
		);
		assert.deepEqual(outcome, { ok: true, assetId: `${txid}_0` });
		assert.deepEqual(steps, ["deploy", "refresh"]);
		assert.deepEqual(logged, []);
	});
});

describe("1Color deploy entry point", () => {
	const read = (path: string) =>
		readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

	it("is on the 1Color page, testnet only, and writes through colorContext", () => {
		assert.match(
			read("app/(main)/wallet/1color/page.tsx"),
			/<OneColorDeploy \/>/,
		);
		const component = read("components/wallet/one-color-deploy.tsx");
		assert.match(component, /isOneColorAvailable\(chain\)/);
		assert.match(component, /runOneColorDeploy\(colorContext, review,/);
		assert.doesNotMatch(component, /oneSatContext|\bwallet\b\s*[,}]/);
		assert.match(component, /queryKey: \["one-color"\]/);
	});

	it("closes the review after a possible deploy and keeps Authorize busy until holdings are re-read", () => {
		const component = read("components/wallet/one-color-deploy.tsx");
		assert.match(
			component,
			/if \(outcome\.mayHaveBeenSent\) setReview\(null\)/,
		);
		const runAt = component.indexOf("await runOneColorDeploy(");
		assert.ok(runAt > 0);
		assert.ok(runAt < component.lastIndexOf("setBusy(false)"));
		assert.match(component, /max-h-\[calc\(100dvh-2rem\)\] overflow-y-auto/);
		assert.match(component, /Supply model/);
		assert.match(component, /Mint authority/);
	});
});

const ASSET_ID = `${txid}_0`;

function recordingSend(result: Send1ColorResult) {
	const calls: Send1ColorInput[] = [];
	const actions: Pick<OneColorActionSet, "send"> = {
		send: async (_ctx, input) => {
			calls.push(input);
			return result;
		},
	};
	return { calls, actions };
}

describe("normalizeHandle (Yours)", () => {
	it("accepts name@domain with or without the leading @, trimmed", () => {
		assert.equal(normalizeHandle("a@b"), "@a@b");
		assert.equal(normalizeHandle("@a@b"), "@a@b");
		assert.equal(
			normalizeHandle("  @alice@testnet.1sat.app "),
			"@alice@testnet.1sat.app",
		);
		assert.equal(
			normalizeHandle("deggen+conf@lkup.net"),
			"@deggen+conf@lkup.net",
		);
	});

	it("rejects bare names, extra @, spaces, addresses and empty input", () => {
		for (const invalid of [
			"a",
			"@a",
			"a@b@c",
			"@a@b@c",
			"a b@c",
			"a@b c",
			"@@a@b",
			"1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
			"",
		]) {
			assert.equal(normalizeHandle(invalid), null, invalid);
		}
	});
});

describe("oneColorSendAmountError", () => {
	it("allows up to the available balance at 0, 8 and 18 decimals, above 2^53", () => {
		assert.equal(oneColorSendAmountError("5", 0, 5n), null);
		assert.equal(oneColorSendAmountError("0.00000001", 8, 1n), null);
		assert.equal(oneColorSendAmountError("1", 18, 10n ** 18n), null);
		assert.equal(
			oneColorSendAmountError("9007199254740993", 0, 9_007_199_254_740_993n),
			null,
		);
	});

	it("uses Yours' messages for malformed and over-balance amounts", () => {
		for (const invalid of ["", "0", ".", "-1", "1e3", "1.001"]) {
			assert.equal(
				oneColorSendAmountError(invalid, 2, 10_000n),
				"Enter a valid amount.",
				invalid,
			);
		}
		assert.equal(
			oneColorSendAmountError("9007199254740994", 0, 9_007_199_254_740_993n),
			"Amount exceeds available balance.",
		);
	});
});

describe("executeOneColorSend", () => {
	it("passes the exact input to send1Color, handle normalized, amount as a string", async () => {
		const { calls, actions } = recordingSend({
			txid,
			tx: [1],
			delivered: "envelope",
			messageId: "m1",
		});
		const result = await executeOneColorSend(
			ctx,
			{
				assetId: ASSET_ID,
				amount: 9_007_199_254_740_993n,
				handle: " alice@testnet.1sat.app ",
				memo: "  thanks  ",
			},
			actions,
		);
		assert.equal(result.delivered, "envelope");
		assert.deepEqual(calls, [
			{
				assetId: ASSET_ID,
				amount: "9007199254740993",
				destination: { handle: "@alice@testnet.1sat.app" },
				memo: "thanks",
			},
		]);
	});

	it("leaves out an empty memo", async () => {
		const { calls, actions } = recordingSend({ txid, delivered: "envelope" });
		await executeOneColorSend(
			ctx,
			{ assetId: ASSET_ID, amount: 1n, handle: "@a@b.c", memo: "   " },
			actions,
		);
		assert.equal("memo" in calls[0], false);
	});

	it("refuses a bad handle or amount before the wallet is asked", async () => {
		const { calls, actions } = recordingSend({ txid });
		const cases: [Parameters<typeof executeOneColorSend>[1], string][] = [
			[{ assetId: ASSET_ID, amount: 1n, handle: "alice" }, "handle-invalid"],
			[
				{ assetId: ASSET_ID, amount: 0n, handle: "@a@b.c" },
				"amount-must-be-positive",
			],
			[
				{
					assetId: ASSET_ID,
					amount: ONE_COLOR_MAX_AMOUNT + 1n,
					handle: "@a@b.c",
				},
				"amount-out-of-range",
			],
		];
		for (const [input, error] of cases) {
			assert.deepEqual(await executeOneColorSend(ctx, input, actions), {
				error,
			});
		}
		assert.equal(calls.length, 0);
	});

	it("keeps the txid of a send whose delivery failed", async () => {
		const { actions } = recordingSend({
			txid,
			tx: [1],
			error: "delivery-failed: sendMessage 503",
		});
		const result = await executeOneColorSend(
			ctx,
			{ assetId: ASSET_ID, amount: 1n, handle: "@a@b.c" },
			actions,
		);
		assert.equal(result.txid, txid);
		assert.equal(result.error, "delivery-failed: sendMessage 503");
	});

	it("reports no-transaction when the action returns no txid", async () => {
		const { actions } = recordingSend({});
		assert.deepEqual(
			await executeOneColorSend(
				ctx,
				{ assetId: ASSET_ID, amount: 1n, handle: "@a@b.c" },
				actions,
			),
			{ error: "no-transaction" },
		);
	});

	it("runs the SDK send as one noSend createAction that the pending scan recognises", async () => {
		const recipient = PrivateKey.fromHex("22".repeat(32))
			.toPublicKey()
			.toString();
		const realFetch = globalThis.fetch;
		const fetched: string[] = [];
		globalThis.fetch = (async (url: string | URL | Request) => {
			const u = String(url);
			fetched.push(u);
			if (u === "https://lkup.net/manifest.json") {
				return new Response(
					JSON.stringify({ metanet: { handles: { version: "1.0" } } }),
				);
			}
			if (
				u ===
				"https://lkup.net/.well-known/metanet-handles/resolve?handle=deggen"
			) {
				return new Response(
					JSON.stringify({
						handle: "deggen",
						domain: "lkup.net",
						identityKey: recipient,
						certificate: { subject: recipient },
						messagebox: "https://messagebox.lkup.net",
						ttl: 3600,
						revoked: false,
					}),
				);
			}
			throw new Error(`unexpected fetch ${u}`);
		}) as typeof fetch;
		const proto = new ProtoWallet(PrivateKey.fromHex("11".repeat(32)));
		const created: CreateActionArgs[] = [];
		const wallet = {
			getPublicKey: (args: Parameters<WalletInterface["getPublicKey"]>[0]) =>
				proto.getPublicKey(args),
			createAction: async (args: CreateActionArgs) => {
				created.push(args);
				return {};
			},
		} as unknown as WalletInterface;
		try {
			const result = await executeOneColorSend(
				{ wallet, chain: "test" } as unknown as OneSatContext,
				{ assetId: ASSET_ID, amount: 60n, handle: "deggen@lkup.net" },
			);
			// The fake returns no transaction, which the SDK reports itself.
			assert.deepEqual(result, { error: "no-transaction" });
		} finally {
			globalThis.fetch = realFetch;
		}
		assert.equal(fetched.length, 2);
		assert.equal(created.length, 1);
		const args = created[0];
		assert.deepEqual(args.options, { noSend: true, randomizeOutputs: false });
		assert.equal(args.inputs, undefined);
		assert.deepEqual(ColorPlan.fromLabels(args.labels)?.operations, [
			{ assetId: ASSET_ID, operation: "transfer" },
		]);
		assert.ok(
			isPendingOneColorSend(
				{ status: "nosend", labels: args.labels },
				oneColorSendPlanLabels(ASSET_ID),
			),
		);
		assert.deepEqual(parseOneColorSendDescription(args.description), {
			amount: 60n,
			handle: "@deggen@lkup.net",
		});
		const token = OneColor.decode(
			LockingScript.fromHex(args.outputs?.[0]?.lockingScript ?? ""),
		);
		assert.equal(token?.role, "value");
		assert.equal(token?.amount, 60n);
	});
});

describe("describeOneColorSendFailure", () => {
	it("says nothing was sent only for the module's own consent refusal", () => {
		for (const error of [
			new ColorConsentDeclinedError("createAction"),
			"BRC-207: the user declined the createAction request",
		]) {
			assert.deepEqual(describeOneColorSendFailure(error), {
				message: "The wallet declined the send. Nothing was sent.",
				mayHaveBeenBuilt: false,
			});
		}
	});

	it("maps checks made before the send is built to specific messages", () => {
		const cases: [string, RegExp][] = [
			["handle-invalid", /@name@domain/],
			["handle has no domain: alice", /@name@domain/],
			["ecosystem aliases are not supported: metanet", /full domain/],
			["amount-must-be-positive", /greater than zero/],
			["amount-out-of-range", /exceeds available balance/],
			["invalid-asset-id: expected <txid>_<vout>", /id isn't valid/],
			["BRC-232: memo exceeds 2000 UTF-8 bytes", /memo is too long/],
			[
				"resolve deggen@lkup.net failed: 404 handle-not-found",
				/No handle @deggen@lkup\.net was found/,
			],
			["resolve deggen@lkup.net failed: 503", /didn't answer/],
			["manifest fetch failed for lkup.net: 502", /didn't answer/],
			["manifest fetch failed for lkup.net: 404", /doesn't offer handles/],
			["lkup.net does not offer handle resolution", /doesn't offer handles/],
			[
				"lkup.net metanet.handles version 2.0 is not supported",
				/doesn't offer handles/,
			],
			[
				"certificate subject does not match identity key for a@b.c",
				/doesn't match its key/,
			],
			[
				`insufficient spendable balance of ${ASSET_ID}`,
				/Not enough spendable tokens/,
			],
			[`the overlay has no admitted deploy for ${ASSET_ID}`, /hasn't admitted/],
			[
				`No 1Color overlay is configured for token ${ASSET_ID} on this network.`,
				/No 1Color overlay/,
			],
			[
				"WERR_INSUFFICIENT_FUNDS: Insufficient funds in the available inputs",
				/Not enough BSV/,
			],
		];
		for (const [error, expected] of cases) {
			const failure = describeOneColorSendFailure(new Error(error));
			assert.match(failure.message, expected, error);
			assert.equal(failure.mayHaveBeenBuilt, false, error);
			assert.doesNotMatch(failure.message, /Nothing was sent/, error);
			assert.ok(failure.message.length < 160, error);
		}
	});

	it("treats no-transaction and unknown failures as possibly built", () => {
		for (const error of [
			new Error("no-transaction"),
			new Error("something unexpected"),
			new HttpError(502, "Bad Gateway"),
		]) {
			const failure = describeOneColorSendFailure(error);
			assert.equal(failure.mayHaveBeenBuilt, true, error.message);
			assert.match(failure.message, /Waiting to be claimed/, error.message);
			assert.doesNotMatch(failure.message, /Nothing was sent/, error.message);
		}
	});
});

describe("runOneColorSend", () => {
	const harness = (send: OneColorActionSet["send"], refreshFails = false) => {
		const steps: string[] = [];
		const logged: [string, unknown, { txid?: string } | undefined][] = [];
		return {
			steps,
			logged,
			options: {
				actions: {
					send: async (...args: Parameters<OneColorActionSet["send"]>) => {
						steps.push("send");
						return send(...args);
					},
				},
				refresh: async () => {
					steps.push("refresh");
					if (refreshFails) throw new Error("listOutputs failed");
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
	const input = { assetId: ASSET_ID, amount: 5n, handle: "alice@b.c" };

	it("refreshes and reports a delivered send", async () => {
		const { steps, logged, options } = harness(async () => ({
			txid,
			delivered: "envelope",
		}));
		assert.deepEqual(await runOneColorSend(ctx, input, options), {
			kind: "sent",
			txid,
			message:
				"Sent to @alice@b.c. They receive it when their wallet next syncs.",
		});
		assert.deepEqual(steps, ["send", "refresh"]);
		assert.deepEqual(logged, []);
	});

	it("reports a failed delivery as built but not delivered, with its txid logged", async () => {
		const { steps, logged, options } = harness(async () => ({
			txid,
			tx: [1],
			error: "delivery-failed: sendMessage 503",
		}));
		const outcome = await runOneColorSend(ctx, input, options);
		assert.equal(outcome.kind, "undelivered");
		assert.equal(outcome.kind === "undelivered" && outcome.txid, txid);
		assert.match(outcome.message, /^Built, but not delivered to @alice@b\.c\./);
		assert.deepEqual(steps, ["send", "refresh"]);
		assert.equal(logged.length, 1);
		assert.equal(logged[0][0], "send-delivery");
		assert.equal(
			(logged[0][1] as Error).message,
			"delivery-failed: sendMessage 503",
		);
		assert.deepEqual(logged[0][2], { txid });
	});

	it("still refreshes when the action throws, and logs a failed refresh", async () => {
		const { steps, logged, options } = harness(async () => {
			throw new Error("something unexpected");
		}, true);
		const outcome = await runOneColorSend(ctx, input, options);
		assert.equal(outcome.kind === "failed" && outcome.mayHaveBeenBuilt, true);
		assert.deepEqual(steps, ["send", "refresh"]);
		assert.deepEqual(
			logged.map(([operation]) => operation),
			["send", "holdings-refresh"],
		);
	});

	it("reports a consent refusal as not sent", async () => {
		const { options } = harness(async () => ({
			error: new ColorConsentDeclinedError("createAction").message,
		}));
		assert.deepEqual(await runOneColorSend(ctx, input, options), {
			kind: "failed",
			message: "The wallet declined the send. Nothing was sent.",
			mayHaveBeenBuilt: false,
		});
	});
});

describe("1Color send entry point", () => {
	const read = (path: string) =>
		readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

	it("is the token page's Send button, testnet only, writing through colorContext", () => {
		const detail = read("components/wallet/one-color-detail.tsx");
		assert.match(detail, /<OneColorSendDialog/);
		assert.match(detail, /<OneColorPendingSends/);
		assert.doesNotMatch(detail, /Send isn't available yet/);
		assert.ok(
			detail.indexOf("<OneColorPendingSends") <
				detail.indexOf('aria-labelledby="one-color-history"'),
		);
		const component = read("components/wallet/one-color-send.tsx");
		assert.match(component, /isOneColorAvailable\(chain\)/);
		assert.match(component, /runOneColorSend\(colorContext, review,/);
		assert.match(component, /runOneColorCancel\(colorContext, send,/);
		assert.doesNotMatch(component, /oneSatContext|\bwallet\b\s*[,}]/);
		assert.match(component, />Handle</);
		assert.match(component, /Waiting to be claimed/);
	});

	it("closes the review after a possible send and keeps Send busy until holdings are re-read", () => {
		const component = read("components/wallet/one-color-send.tsx");
		assert.match(
			component,
			/if \(outcome\.mayHaveBeenBuilt\) setReview\(null\)/,
		);
		const runAt = component.indexOf("await runOneColorSend(");
		assert.ok(runAt > 0);
		assert.ok(runAt < component.indexOf("setBusy(false)", runAt));
		assert.match(component, /if \(busy\) return;/);
		assert.match(component, /refreshBalance\(\)/);
		assert.match(component, /max-h-\[calc\(100dvh-2rem\)\] overflow-y-auto/);
		assert.match(component, /w-full sm:w-auto/);
	});
});
