import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Bsv20Balance, TokenBalance } from "@1sat/actions";
import type { IndexedOutput } from "@1sat/types";
import { PrivateKey, type WalletInterface } from "@bsv/sdk";
import {
	buildKeys,
	cancelledListingCount,
	encodedBinaryBytes,
	executeKeySweep,
	executeMigrationSweep,
	migrationSweepKeys,
	type SweepActions,
	type SweepProgress,
	WALLET_SERVER_MAX_REQUEST_BYTES,
} from "@/lib/sweep-migration";
import {
	BSV20_UNCONFIRMED_REASON,
	BSV20_UNREADABLE_REASON,
	hasIndexedBsv20Amount,
	splitBsv20Outputs,
} from "@/lib/wallet/migration-listings";
import { beefServices, prooflessBeef, provenBeef } from "./fixtures/sweep-beef";

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
		services: beefServices(),
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
		const listed = out(1, [`own:${ordAddress}`, "ordlock2", "amt:10"]);
		const a = out(2, [`own:${ordAddress}`, "amt:20"]);
		const b = { ...out(3), data: { bsv20: { tick: "PEPE", amt: "30" } } };
		const c = out(4, [`own:${ordAddress}`, "amt:5"]);
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
		const a = out(1, [`own:${ordAddress}`, "amt:7"]);
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

	it("never batches or sweeps an amount the indexer did not give", async () => {
		// Same ticker: one indexer-confirmed output, one whose amount is only in
		// its inscription JSON (and could over-claim).
		const confirmed = out(1, [`own:${ordAddress}`, "amt:10"]);
		const jsonOnly = {
			...out(2),
			data: {
				insc: {
					json: { p: "bsv-20", op: "transfer", tick: "PEPE", amt: "999999" },
				},
			},
		};
		const { actions, calls } = fakeActions();
		const { result } = await sweep(
			{
				bsv20Tokens: [
					{
						tick: "PEPE",
						decimals: 0,
						totalAmount: 1000009n,
						outputs: [confirmed, jsonOnly],
						amounts: new Map([
							[confirmed.outpoint, "10"],
							[jsonOnly.outpoint, "999999"],
						]),
					},
				],
			},
			actions,
		);
		assert.deepEqual(
			calls.map((call) => call.inputs.map((i) => i.outpoint)),
			[[confirmed.outpoint]],
		);
		assert.match(
			result.errors.join("\n"),
			new RegExp(
				`${jsonOnly.outpoint} was not swept: amount comes only from the inscription text`,
			),
		);
	});
});

describe("BSV-20 sweep selection", () => {
	it("leaves JSON-only amounts at their address with a reason", () => {
		const viaEvent = out(1, [`own:${ordAddress}`, "tick:PEPE", "amt:10"]);
		const viaData = { ...out(2), data: { bsv20: { tick: "PEPE", amt: "5" } } };
		const jsonOnly = {
			...out(3),
			data: {
				insc: {
					json: { p: "bsv-20", op: "transfer", tick: "PEPE", amt: "50" },
				},
			},
		};
		const unreadable = out(4);
		const { balances, unsweepable } = splitBsv20Outputs([
			viaEvent,
			viaData,
			jsonOnly,
			unreadable,
		]);
		assert.equal(balances.length, 1);
		assert.deepEqual(
			balances[0].outputs.map((o) => o.outpoint),
			[viaEvent.outpoint, viaData.outpoint],
		);
		assert.equal(balances[0].totalAmount, 15n);
		assert.deepEqual(
			unsweepable.map((u) => [u.output.outpoint, u.reason]),
			[
				[jsonOnly.outpoint, BSV20_UNCONFIRMED_REASON],
				[unreadable.outpoint, BSV20_UNREADABLE_REASON],
			],
		);
		assert.equal(hasIndexedBsv20Amount(jsonOnly), false);
	});
});

describe("legacy sweep: ordinals", () => {
	it("puts each listed ordinal (v1 or v2) in its own transaction", async () => {
		const v1 = out(1, [`own:${ordAddress}`, "ordlock"]);
		const v2 = out(2, [`own:${ordAddress}`, "ordlock2"]);
		const plain = [out(3), out(4), out(5)];
		const { actions, calls } = fakeActions({
			sweepOrdinals: async (_ctx, request) => {
				const outpoints = request.inputs.map((i) => i.outpoint);
				calls.push({
					action: "ordinals",
					inputs: request.inputs as unknown as Record<string, unknown>[],
				});
				// A bad v1 listing fails alone.
				return outpoints.includes(v1.outpoint)
					? { error: "bad listing" }
					: { txid: `ord-${calls.length}` };
			},
		});
		const { result } = await sweep({ ordinals: [v1, ...plain, v2] }, actions);
		assert.deepEqual(
			calls.map((call) => call.inputs.map((i) => i.outpoint)),
			[[v1.outpoint], [v2.outpoint], plain.map((o) => o.outpoint)],
		);
		assert.equal(result.ordinalTxids.length, 2);
		assert.match(result.errors.join("\n"), /bad listing/);
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

describe("key-list sweep", () => {
	const keyA = PrivateKey.fromHex("05".repeat(32));
	const keyB = PrivateKey.fromHex("06".repeat(32));
	const addressA = keyA.toPublicKey().toAddress();
	const addressB = keyB.toPublicKey().toAddress();

	function sweepKeys(
		keys: { label: string; wif: string }[],
		params: Partial<Parameters<typeof executeKeySweep>[0]>,
		actions: Partial<SweepActions>,
	) {
		const originalError = console.error;
		console.error = () => undefined;
		return executeKeySweep({
			wallet: {} as WalletInterface,
			services: beefServices(),
			keys,
			onProgress: () => undefined,
			funding: [],
			ordinals: [],
			bsv21Tokens: [],
			...params,
			actions,
		}).finally(() => {
			console.error = originalError;
		});
	}

	it("signs each output with the listed key its own: event names", async () => {
		const signed: string[][] = [];
		const { actions } = fakeActions({
			sweepBsv: (async (_ctx: unknown, request: { keys: PrivateKey[] }) => {
				signed.push(request.keys.map((k) => k.toWif()));
				return { txid: "bsv-1" };
			}) as unknown as SweepActions["sweepBsv"],
		});
		const result = await sweepKeys(
			[
				{ label: "First", wif: keyA.toWif() },
				{ label: "Second", wif: keyB.toWif() },
			],
			{
				funding: [
					out(1, [`own:${addressB}`], 1000),
					out(2, [`own:${addressA}`], 2000),
				],
			},
			actions,
		);
		assert.deepEqual(result.bsvTxids, ["bsv-1"]);
		assert.deepEqual(result.errors, []);
		assert.deepEqual(signed, [[keyB.toWif(), keyA.toWif()]]);
	});

	it("names an unreadable key by its label, never its text, and sweeps with the rest", async () => {
		const badWif = `${keyB.toWif().slice(0, -4)}0OIl`;
		const { actions, calls } = fakeActions();
		const result = await sweepKeys(
			[
				{ label: "Pasted", wif: badWif },
				{ label: "Backup", wif: keyA.toWif() },
			],
			{ funding: [out(1, [`own:${addressA}`], 1000)] },
			actions,
		);
		assert.equal(calls.length, 1);
		assert.equal(result.errors.length, 1);
		assert.match(result.errors[0], /^Pasted key could not be read/);
		assert.doesNotMatch(result.errors[0], new RegExp(badWif));
	});

	it("does not sign an output at an address no listed key owns", async () => {
		const { actions, calls } = fakeActions();
		const result = await sweepKeys(
			[{ label: "Pasted", wif: keyA.toWif() }],
			{ funding: [out(1, [`own:${payAddress}`], 1000)] },
			actions,
		);
		assert.equal(calls.length, 0);
		assert.match(result.errors[0], /No key for output/);
	});

	it("keeps the migration's three named keys, in order, without unset ones", () => {
		assert.deepEqual(
			migrationSweepKeys({
				legacyPayWif: payKey.toWif(),
				legacyOrdWif: ordKey.toWif(),
			}),
			[
				{ label: "Legacy pay", wif: payKey.toWif() },
				{ label: "Legacy ord", wif: ordKey.toWif() },
			],
		);
		assert.equal(
			migrationSweepKeys({
				legacyPayWif: payKey.toWif(),
				legacyOrdWif: ordKey.toWif(),
				legacyIdentityWif: "x",
			})[2].label,
			"Legacy identity",
		);
	});
});

describe("sweep log prefix", () => {
	const badWif = `${payKey.toWif().slice(0, -4)}0OIl`;
	async function logged(prefix?: string) {
		const lines: string[] = [];
		const originalError = console.error;
		console.error = (first: unknown) => lines.push(String(first));
		try {
			const { actions } = fakeActions();
			await executeKeySweep({
				wallet: {} as WalletInterface,
				services: beefServices(),
				keys: [{ label: "Legacy pay", wif: badWif }],
				onProgress: () => undefined,
				funding: [],
				ordinals: [],
				bsv21Tokens: [],
				actions,
				...(prefix ? { logPrefix: prefix } : {}),
			});
		} finally {
			console.error = originalError;
		}
		return lines;
	}

	it("keeps the migration's log text and uses the caller's prefix", async () => {
		assert.deepEqual(await logged(), [
			"[migration] legacy pay key could not be read",
		]);
		assert.deepEqual(await logged("[sweep]"), [
			"[sweep] legacy pay key could not be read",
		]);
	});
});

const TOO_LARGE = "WalletStorageClient rpcCall: network error 413";

/**
 * A wallet like the real one around the sweep actions: createAction is the
 * request the wallet server can refuse as too large (before anything is
 * signed), signAction signs and broadcasts.
 */
function sizeLimitedWallet(
	tooLarge: (inputs: { outpoint: string }[]) => boolean,
) {
	const log = {
		signed: [] as string[][],
		refused: [] as string[][],
		/** Every createAction, in order, and whether it was then signed */
		attempts: [] as { outpoints: string[]; signed: boolean }[],
	};
	const wallet = {
		createAction: async (args: { inputs: { outpoint: string }[] }) => {
			const outpoints = args.inputs.map((i) => i.outpoint);
			if (tooLarge(args.inputs)) {
				log.refused.push(outpoints);
				log.attempts.push({ outpoints, signed: false });
				throw new Error(TOO_LARGE);
			}
			log.attempts.push({ outpoints, signed: true });
			return { signableTransaction: { reference: "ref", tx: [] } };
		},
		signAction: async () => ({ txid: `tx-${log.signed.length + 1}` }),
	};
	return { wallet: wallet as unknown as WalletInterface, log };
}

/** An ordinal sweep action shaped like @1sat/actions': createAction, then signAction. */
const twoPhaseOrdinals =
	(log: { signed: string[][] }): SweepActions["sweepOrdinals"] =>
	async (ctx, request) => {
		const inputs = request.inputs.map((i) => ({
			outpoint: i.outpoint,
			inputDescription: `Ordinal ${i.outpoint}`,
		}));
		try {
			await ctx.wallet.createAction({ description: "sweep", inputs });
			const signed = await ctx.wallet.signAction({
				reference: "ref",
				spends: {},
			});
			log.signed.push(inputs.map((i) => i.outpoint));
			return { txid: signed.txid };
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	};

describe("legacy sweep: requests too large for the wallet server", () => {
	it("splits a refused batch in half until each part fits, and reports a lone input that never fits", async () => {
		const ordinals = [1, 2, 3, 4, 5, 6, 7].map((n) => out(n));
		const huge = ordinals[3].outpoint;
		const { wallet, log } = sizeLimitedWallet(
			(inputs) => inputs.length > 2 || inputs.some((i) => i.outpoint === huge),
		);
		const { actions } = fakeActions({ sweepOrdinals: twoPhaseOrdinals(log) });
		const { result, progress } = await sweep({ wallet, ordinals }, actions);

		// Every part that went through holds at most 2 inputs, none twice.
		const swept = log.signed.flat();
		assert.ok(log.signed.every((batch) => batch.length <= 2));
		assert.equal(new Set(swept).size, swept.length);
		assert.deepEqual(
			[...swept].sort(),
			ordinals
				.map((o) => o.outpoint)
				.filter((o) => o !== huge)
				.sort(),
		);
		assert.equal(result.ordinalTxids.length, log.signed.length);
		// Halving: 7 -> 4 + 3; 4 -> 2 + 2 (the pair with the huge input
		// split again down to the huge one alone); 3 -> 2 + 1.
		assert.deepEqual(
			log.refused.map((batch) => batch.length),
			[7, 4, 2, 1, 3],
		);
		assert.deepEqual(
			log.signed.map((batch) => batch.length),
			[2, 1, 2, 1],
		);
		// Nothing that went through was sent again.
		log.attempts.forEach((attempt, i) => {
			if (!attempt.signed) return;
			for (const later of log.attempts.slice(i + 1)) {
				for (const outpoint of attempt.outpoints) {
					assert.ok(!later.outpoints.includes(outpoint), outpoint);
				}
			}
		});
		assert.equal(log.refused.flat().filter((o) => o === huge).length, 4);

		const left = result.leftBehind ?? [];
		assert.equal(left.length, 1);
		assert.equal(left[0].outpoint, huge);
		assert.match(
			left[0].reason,
			/this inscription's transaction is \d+ KB, more than the wallet server accepts in one request; it stays at your old address\./,
		);
		assert.equal(left[0].txid, txid(4));
		assert.ok((left[0].beefBytes ?? 0) > 0);
		assert.equal(left[0].detail, TOO_LARGE);
		// The user-facing errors are plain words.
		assert.equal(result.errors.length, 1);
		assert.doesNotMatch(result.errors.join("\n"), /413|rpcCall/);
		const step = progress.at(-1)?.steps.find((s) => s.id === "ordinals");
		assert.equal(step?.status, "error");
		assert.equal(progress.at(-1)?.percent, 100);
	});

	it("never retries once signAction ran, even if the error reads 413", async () => {
		const ordinals = [out(1), out(2)];
		const attempts: string[][] = [];
		const wallet = {
			createAction: async () => ({
				signableTransaction: { reference: "ref", tx: [] },
			}),
			signAction: async () => {
				throw new Error(TOO_LARGE);
			},
		} as unknown as WalletInterface;
		const { actions } = fakeActions({
			sweepOrdinals: async (ctx, request) => {
				attempts.push(request.inputs.map((i) => i.outpoint));
				try {
					await ctx.wallet.createAction({ description: "sweep" });
					await ctx.wallet.signAction({ reference: "ref", spends: {} });
					return { txid: "never" };
				} catch (error) {
					return { error: (error as Error).message };
				}
			},
		});
		const { result } = await sweep({ wallet, ordinals }, actions);
		assert.equal(attempts.length, 1);
		assert.equal(result.ordinalTxids.length, 0);
		assert.equal(result.leftBehind?.length, 2);
	});

	it("never retries a 413 that didn't come from the wallet's createAction", async () => {
		const attempts: number[] = [];
		const { actions } = fakeActions({
			sweepOrdinals: async (_ctx, request) => {
				attempts.push(request.inputs.length);
				return { error: TOO_LARGE };
			},
		});
		await sweep({ ordinals: [out(1), out(2)] }, actions);
		assert.deepEqual(attempts, [2]);
	});

	it("packs batches by the size of their source BEEFs", async () => {
		// 2.5 MB each: two fit one request (base64 ~6.7 MB), three don't.
		const big = provenBeef(2_500_000);
		const services = beefServices(() => big);
		const { actions, calls } = fakeActions();
		const ordinals = [1, 2, 3, 4].map((n) => out(n));
		await sweep({ services, ordinals }, actions);
		assert.deepEqual(
			calls.map((c) => c.inputs.length),
			[2, 2],
		);
	});

	it("sends a source BEEF larger than a request on its own", async () => {
		const huge = provenBeef(7_000_000);
		const small = provenBeef(10);
		const services = beefServices((id) => (id === txid(2) ? huge : small));
		const { actions, calls } = fakeActions();
		const ordinals = [out(1), out(2), out(3)];
		await sweep({ services, ordinals }, actions);
		assert.deepEqual(
			calls.map((c) => c.inputs.map((i) => i.outpoint)),
			[[out(1).outpoint], [out(2).outpoint], [out(3).outpoint]],
		);
	});

	it("budgets the 8 MiB request limit for base64-encoded BEEF", () => {
		assert.equal(WALLET_SERVER_MAX_REQUEST_BYTES, 8_388_608);
		assert.equal(
			encodedBinaryBytes(3_000_000),
			JSON.stringify({ $bsvBinary: "base64", data: "A".repeat(4_000_000) })
				.length,
		);
	});
});

describe("legacy sweep: source transactions without a proof", () => {
	it("never sends an input whose source BEEF is not valid, and fetches each source once", async () => {
		const fetched: string[] = [];
		const services = beefServices(
			(id) => (id === txid(2) ? prooflessBeef() : provenBeef()),
			fetched,
		);
		const { actions, calls } = fakeActions({
			sweepOrdinals: async (ctx, request) => {
				calls.push({
					action: "ordinals",
					inputs: request.inputs as unknown as Record<string, unknown>[],
				});
				// The action fetches its BEEFs again, as @1sat/actions does.
				for (const input of request.inputs) {
					const beef = await ctx.services?.getBeefForTxid(
						input.outpoint.split(".")[0],
					);
					assert.equal(beef?.isValid(), true);
				}
				return { txid: "ord-1" };
			},
		});
		const { result } = await sweep(
			{ services, ordinals: [out(1), out(2), out(3)] },
			actions,
		);

		assert.deepEqual(
			calls.map((c) => c.inputs.map((i) => i.outpoint)),
			[[out(1).outpoint, out(3).outpoint]],
		);
		assert.deepEqual([...fetched].sort(), [txid(1), txid(2), txid(3)].sort());
		const left = result.leftBehind ?? [];
		assert.equal(left.length, 1);
		assert.equal(left[0].outpoint, out(2).outpoint);
		assert.match(
			left[0].reason,
			/its source transaction has no confirmation proof from the indexer yet; try again after it's confirmed/,
		);
		assert.equal(left[0].txid, txid(2));
		assert.ok((left[0].beefBytes ?? 0) > 0);
		assert.match(left[0].detail ?? "", /not valid.*1 txs, 0 bumps/);
		assert.deepEqual(result.ordinalTxids, ["ord-1"]);
	});
});
