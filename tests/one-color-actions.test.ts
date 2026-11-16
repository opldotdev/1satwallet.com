import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Deploy1ColorInput, OneSatContext } from "@1sat/actions";
import { OneColor } from "@1sat/templates";
import { ColorPlan, ISSUE } from "@bsv/color-permission-module";
import {
	type CreateActionArgs,
	LockingScript,
	PrivateKey,
	ProtoWallet,
	type WalletInterface,
} from "@bsv/sdk";
import {
	executeOneColorDeploy,
	formatOneColorAmount,
	ONE_COLOR_MAX_AMOUNT,
	ONE_COLOR_MAX_ICON_BYTES,
	type OneColorActionSet,
	oneColorDeployFailureMessage,
	parseOneColorAmount,
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
	const actions: OneColorActionSet = {
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

describe("oneColorDeployFailureMessage", () => {
	it("maps each failure to a short, specific message", () => {
		const cases: [string, RegExp][] = [
			["decimals-out-of-range", /0 through 18/],
			["dec must be an integer 0-18", /0 through 18/],
			["amount-out-of-range", /2\^64-1/],
			["symbol-invalid", /at most 32 characters/],
			["icon-too-large", /at most 100 KB/],
			["icon-not-image", /image file/],
			["no-transaction", /no transaction/],
			["Insufficient funds in the available inputs", /Not enough BSV/],
			["User denied the request", /declined/],
			["1Color overlay https://x answered with a freeform answer", /overlay/],
			["something unexpected", /1Color deploy failed/],
		];
		for (const [error, expected] of cases) {
			const message = oneColorDeployFailureMessage(new Error(error));
			assert.match(message, expected, error);
			assert.ok(message.length < 160, error);
		}
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
		assert.match(component, /executeOneColorDeploy\(colorContext, review\)/);
		assert.doesNotMatch(component, /oneSatContext|\bwallet\b\s*[,}]/);
		assert.match(component, /queryKey: \["one-color"\]/);
	});
});
