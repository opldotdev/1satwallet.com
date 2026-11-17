import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Bsv20Balance, TokenBalance } from "@1sat/actions";
import type { IndexedOutput } from "@1sat/types";
import type { OneSatServices } from "@1sat/wallet-browser";
import { PrivateKey, type WalletInterface } from "@bsv/sdk";
import {
	buildKeys,
	cancelledListingCount,
	executeMigrationSweep,
	type SweepActions,
	type SweepProgress,
} from "@/lib/sweep-migration";

const payKey = PrivateKey.fromHex("01".repeat(32));
const ordKey = PrivateKey.fromHex("02".repeat(32));
const payAddress = payKey.toPublicKey().toAddress();
const ordAddress = ordKey.toPublicKey().toAddress();
const otherAddress = PrivateKey.fromHex("09".repeat(32))
	.toPublicKey()
	.toAddress();

const txid = (n: number) => n.toString(16).padStart(64, "0");
const out = (
	n: number,
	events: string[] = [`own:${ordAddress}`],
	satoshis = 1,
): IndexedOutput => ({
	outpoint: `${txid(n)}.0`,
	score: n,
	satoshis,
	events,
});

type Call = { action: string; inputs: Record<string, unknown>[] };

function fakeActions(overrides: Partial<SweepActions> = {}) {
	const calls: Call[] = [];
	let counter = 0;
	const record =
		(action: string) =>
		async (_ctx: unknown, request: { inputs: object[] }) => {
			calls.push({
				action,
				inputs: request.inputs as Record<string, unknown>[],
			});
			counter++;
			return { txid: `${action}-${counter}` };
		};
	const actions: Partial<SweepActions> = {
		prepareSweepInputs: async (_ctx, utxos) =>
			utxos.map((u) => ({
				outpoint: u.outpoint,
				satoshis: u.satoshis ?? 1,
				lockingScript: "76a914",
			})),
		sweepBsv: record("bsv") as SweepActions["sweepBsv"],
		sweepOrdinals: record("ordinals") as SweepActions["sweepOrdinals"],
		sweepBsv20: record("bsv20") as SweepActions["sweepBsv20"],
		sweepBsv21: record("bsv21") as SweepActions["sweepBsv21"],
		...overrides,
	};
	return { actions, calls };
}

function sweep(
	params: Partial<Parameters<typeof executeMigrationSweep>[0]>,
	actions: Partial<SweepActions>,
) {
	const progress: SweepProgress[] = [];
	const originalError = console.error;
	console.error = () => undefined;
	return executeMigrationSweep({
		wallet: {} as WalletInterface,
		services: {} as OneSatServices,
		legacyPayWif: payKey.toWif(),
		legacyOrdWif: ordKey.toWif(),
		onProgress: (p) => progress.push(p),
		funding: [],
		ordinals: [],
		bsv21Tokens: [],
		...params,
		actions,
	})
		.then((result) => ({ result, progress }))
		.finally(() => {
			console.error = originalError;
		});
}

const bsv21 = (
	outputs: IndexedOutput[],
	amounts: [string, string][],
): TokenBalance => ({
	tokenId: `${txid(999)}_0`,
	symbol: "TOK",
	decimals: 0,
	totalAmount: 0n,
	outputs,
	amounts: new Map(amounts),
	isActive: true,
});

describe("legacy sweep key lookup", () => {
	const keyMap = new Map([
		[payAddress, payKey],
		[ordAddress, ordKey],
	]);

	it("resolves an output whose own: event for our key is not the first", () => {
		const [key] = buildKeys(
			[out(1, [`own:${otherAddress}`, `own:${payAddress}`])],
			keyMap,
		);
		assert.equal(key.toWif(), payKey.toWif());
	});

	it("refuses to sign when an output names two of our keys or none", () => {
		assert.throws(
			() =>
				buildKeys([out(1, [`own:${payAddress}`, `own:${ordAddress}`])], keyMap),
			/more than one/,
		);
		assert.throws(
			() => buildKeys([out(2, [`own:${otherAddress}`])], keyMap),
			/No key for output/,
		);
	});
});

describe("legacy sweep: BSV-20", () => {
	it("sweeps each ticker in its own step, listed outputs one per tx, amounts by canonical outpoint", async () => {
		const listed = out(1, [`own:${ordAddress}`, "ordlock2"]);
		const a = out(2);
		const b = out(3);
		const c = out(4);
		const tokens: Bsv20Balance[] = [
			{
				tick: "PEPE",
				decimals: 0,
				totalAmount: 60n,
				outputs: [listed, a, b],
				// indexer `_` form vs the output's `.` form
				amounts: new Map([
					[listed.outpoint.replace(".", "_"), "10"],
					[a.outpoint.replace(".", "_"), "20"],
					[b.outpoint, "30"],
				]),
			},
			{
				tick: "ORDI",
				decimals: 0,
				totalAmount: 5n,
				outputs: [c],
				amounts: new Map([[c.outpoint, "5"]]),
			},
		];
		const { actions, calls } = fakeActions();
		const { result, progress } = await sweep({ bsv20Tokens: tokens }, actions);

		assert.deepEqual(
			calls.map((call) => [
				call.action,
				call.inputs.map((i) => [i.outpoint, i.tick, i.amount]),
			]),
			[
				["bsv20", [[listed.outpoint, "PEPE", "10"]]],
				[
					"bsv20",
					[
						[a.outpoint, "PEPE", "20"],
						[b.outpoint, "PEPE", "30"],
					],
				],
				["bsv20", [[c.outpoint, "ORDI", "5"]]],
			],
		);
		assert.equal(result.bsv20Txids.length, 3);
		assert.deepEqual(result.errors, []);
		assert.deepEqual(result.cancelledListings, [listed.outpoint]);
		assert.equal(cancelledListingCount(result), 1);
		const steps = progress.at(-1)?.steps ?? [];
		assert.deepEqual(
			steps.map((s) => [s.id, s.status]),
			[
				["bsv20:PEPE", "done"],
				["bsv20:ORDI", "done"],
			],
		);
	});

	it("never sends a token input without its amount", async () => {
		const a = out(1);
		const { actions, calls } = fakeActions();
		const { result } = await sweep(
			{
				bsv20Tokens: [
					{
						tick: "PEPE",
						decimals: 0,
						totalAmount: 0n,
						outputs: [a],
						amounts: new Map(),
					},
				],
			},
			actions,
		);
		assert.equal(calls.length, 0);
		assert.match(result.errors.join("\n"), /no token amount for output/);
	});
});

describe("legacy sweep: BSV-21", () => {
	it("puts a listed output in its own transaction", async () => {
		const listed = out(1, [`own:${ordAddress}`, "list:500"]);
		const rest = [out(2), out(3), out(4)];
		const amounts: [string, string][] = [listed, ...rest].map((o) => [
			o.outpoint,
			"1",
		]);
		const { actions, calls } = fakeActions();
		await sweep(
			{ bsv21Tokens: [bsv21([out(2), listed, out(3), out(4)], amounts)] },
			actions,
		);
		assert.deepEqual(
			calls.map((call) => call.inputs.map((i) => i.outpoint)),
			[[listed.outpoint], rest.map((o) => o.outpoint)],
		);
	});

	it("reports inputs the overlay did not accept instead of marking the step done", async () => {
		const a = out(1);
		const b = out(2);
		const { actions } = fakeActions({
			sweepBsv21: async () => ({
				txid: "tok-1",
				// the overlay accepted only `a`, in the `_` form
				spentOutpoints: [a.outpoint.replace(".", "_")],
			}),
		});
		const { result, progress } = await sweep(
			{
				bsv21Tokens: [
					bsv21(
						[a, b],
						[
							[a.outpoint, "4"],
							[b.outpoint, "6"],
						],
					),
				],
			},
			actions,
		);
		assert.deepEqual(result.bsv21Txids, ["tok-1"]);
		assert.equal(result.errors.length, 1);
		assert.match(result.errors[0], /not accepted by the token overlay/);
		assert.match(result.errors[0], new RegExp(b.outpoint));
		assert.doesNotMatch(result.errors[0], new RegExp(a.outpoint));
		const step = progress.at(-1)?.steps.find((s) => s.id.startsWith("token:"));
		assert.equal(step?.status, "error");
		assert.deepEqual(step?.txids, ["tok-1"]);
	});
});

describe("legacy sweep: skipped outputs", () => {
	it("sweeps the rest of a chunk but does not mark the step done when one source tx is missing", async () => {
		const good = out(1, [`own:${payAddress}`], 500);
		const missing = out(2, [`own:${payAddress}`], 700);
		const base = fakeActions();
		const { actions } = fakeActions({
			prepareSweepInputs: async (ctx, utxos) => {
				if (utxos.some((u) => u.outpoint === missing.outpoint)) {
					throw new Error("Transaction not found in BEEF");
				}
				return (
					base.actions.prepareSweepInputs as SweepActions["prepareSweepInputs"]
				)(ctx, utxos);
			},
		});
		const { result, progress } = await sweep(
			{ funding: [good, missing] },
			actions,
		);
		assert.deepEqual(result.bsvTxids, ["bsv-1"]);
		assert.match(
			result.errors.join("\n"),
			new RegExp(`skipped ${missing.outpoint}`),
		);
		const step = progress.at(-1)?.steps.find((s) => s.id === "bsv");
		assert.equal(step?.status, "error");
		assert.equal(step?.error, "1 of 1 batch failed");
	});
});

describe("legacy sweep: unreadable keys", () => {
	it("reports a malformed legacy key without its text and sweeps with the others", async () => {
		const badWif = `${ordKey.toWif().slice(0, -4)}0OIl`;
		const { actions, calls } = fakeActions();
		const { result } = await sweep(
			{
				legacyOrdWif: badWif,
				funding: [out(1, [`own:${payAddress}`], 1000)],
			},
			actions,
		);
		assert.equal(calls.length, 1);
		assert.deepEqual(result.bsvTxids, ["bsv-1"]);
		assert.equal(result.errors.length, 1);
		assert.match(result.errors[0], /Legacy ord key could not be read/);
		assert.doesNotMatch(result.errors[0], new RegExp(badWif));
	});
});
