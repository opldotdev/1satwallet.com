import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OneColor } from "@1sat/templates";
import {
	type ListActionsArgs,
	LockingScript,
	type WalletAction,
	type WalletActionInput,
	type WalletActionOutput,
} from "@bsv/sdk";
import {
	fetchOneColorHistory,
	ONE_COLOR_HISTORY_PAGE,
	oneColorActionAmount,
} from "@/lib/wallet/one-color";

// Cases from Yours (1color branch) src/services/oneColor.test.ts
// `oneColorActionAmount`, plus spending a fixed-supply deploy output.

const TXID = "ef".repeat(32);
const ASSET = `${"ab".repeat(32)}_0`;
const OTHER = `${"cd".repeat(32)}_0`;
const pkh = new Array(20).fill(7);
const value = (assetId: string, amount: bigint) =>
	OneColor.value(assetId, amount, { lock: pkh }).lock().toHex();
const authority = (assetId: string) =>
	OneColor.authority(assetId, { lock: pkh }).lock().toHex();
// An AMM pool: a 1Color value output whose lock is a covenant, not P2PKH.
const covenant = LockingScript.fromHex(`6a28${"ab".repeat(40)}`);
const pool = (amount: bigint) =>
	OneColor.value(ASSET, amount, { lock: covenant }).lock().toHex();

const base = { txid: TXID };
const out = (
	lockingScript: string,
	outputIndex: number,
	basket?: string,
): WalletActionOutput => ({
	lockingScript,
	outputIndex,
	satoshis: 1,
	spendable: true,
	tags: [],
	outputDescription: "",
	basket: basket ?? "",
});
const inp = (
	sourceLockingScript: string,
	sourceOutpoint = `${"12".repeat(32)}.0`,
): WalletActionInput => ({
	sourceOutpoint,
	sourceSatoshis: 1,
	sourceLockingScript,
	inputDescription: "",
	sequenceNumber: 0,
});

describe("oneColorActionAmount", () => {
	it("a send: the value output that is not ours is the amount", () => {
		const r = oneColorActionAmount(
			{
				...base,
				inputs: [inp(value(ASSET, 100n))],
				outputs: [
					out(value(ASSET, 60n), 0),
					out(value(ASSET, 40n), 1, "p color abc"),
				],
			},
			ASSET,
		);
		assert.deepEqual(r, { direction: "sent", amount: 60n });
	});

	it("a receive: value filed into our p color basket, no inputs", () => {
		const r = oneColorActionAmount(
			{ ...base, outputs: [out(value(ASSET, 7n), 0, "p color abc")] },
			ASSET,
		);
		assert.deepEqual(r, { direction: "received", amount: 7n });
	});

	it("a deploy at this action's output 0 counts as the asset arriving", () => {
		const deploy = OneColor.deployValue(1000n, { lock: pkh }).lock().toHex();
		const r = oneColorActionAmount(
			{ ...base, outputs: [out(deploy, 0, "p color abc")] },
			`${TXID}_0`,
		);
		assert.deepEqual(r, { direction: "received", amount: 1000n });
	});

	it("an authority deploy is a transfer of nothing, not a receive", () => {
		const deploy = OneColor.deployAuthority({ lock: pkh }).lock().toHex();
		const r = oneColorActionAmount(
			{ ...base, outputs: [out(deploy, 0, "p color abc")] },
			`${TXID}_0`,
		);
		assert.deepEqual(r, { direction: "transfer", amount: 0n });
	});

	it("a deploy that is not output 0 is no asset", () => {
		const deploy = OneColor.deployValue(1000n, { lock: pkh }).lock().toHex();
		assert.equal(
			oneColorActionAmount(
				{ ...base, outputs: [out(deploy, 1, "p color abc")] },
				`${TXID}_1`,
			),
			null,
		);
	});

	it("spending the fixed-supply deploy output counts it as leaving", () => {
		const deployTxid = "ab".repeat(32);
		const deploy = OneColor.deployValue(1000n, { lock: pkh }).lock().toHex();
		const r = oneColorActionAmount(
			{
				...base,
				inputs: [inp(deploy, `${deployTxid}.0`)],
				outputs: [
					out(value(ASSET, 300n), 0),
					out(value(ASSET, 700n), 1, "p color abc"),
				],
			},
			ASSET,
		);
		assert.deepEqual(r, { direction: "sent", amount: 300n });
	});

	it("an action that touches another asset, or no token at all: null", () => {
		assert.equal(
			oneColorActionAmount(
				{ ...base, outputs: [out(value(OTHER, 1n), 0, "p color x")] },
				ASSET,
			),
			null,
		);
		assert.equal(
			oneColorActionAmount(
				{ ...base, outputs: [out(`76a914${"00".repeat(20)}88ac`, 0)] },
				ASSET,
			),
			null,
		);
		assert.equal(oneColorActionAmount({ ...base }, ASSET), null);
	});

	it("inputs and outputs that net to nothing: a transfer", () => {
		const r = oneColorActionAmount(
			{
				...base,
				inputs: [inp(value(ASSET, 10n))],
				outputs: [out(value(ASSET, 10n), 0, "p color abc")],
			},
			ASSET,
		);
		assert.deepEqual(r, { direction: "transfer", amount: 0n });
	});

	it("authority outputs and inputs move no value but involve the asset", () => {
		const r = oneColorActionAmount(
			{
				...base,
				inputs: [inp(authority(ASSET))],
				outputs: [out(authority(ASSET), 0, "p color abc")],
			},
			ASSET,
		);
		assert.deepEqual(r, { direction: "transfer", amount: 0n });
	});

	it("a covenant input is not ours: an LP close reads as received", () => {
		const r = oneColorActionAmount(
			{
				...base,
				inputs: [inp(pool(5000n))],
				outputs: [out(value(ASSET, 5000n), 0, "p color abc")],
			},
			ASSET,
		);
		assert.deepEqual(r, { direction: "received", amount: 5000n });
	});

	it("tokens put into a covenant output are sent", () => {
		const r = oneColorActionAmount(
			{
				...base,
				inputs: [inp(value(ASSET, 6000n))],
				outputs: [
					out(pool(5000n), 0),
					out(value(ASSET, 1000n), 1, "p color abc"),
				],
			},
			ASSET,
		);
		assert.deepEqual(r, { direction: "sent", amount: 5000n });
	});
});

describe("fetchOneColorHistory", () => {
	// Actions in storage order, oldest first; odd ones receive the asset.
	const actionAt = (n: number): WalletAction => ({
		txid: n.toString(16).padStart(64, "0"),
		satoshis: 0,
		status: "completed",
		isOutgoing: false,
		description: `action ${n}`,
		version: 1,
		lockTime: 0,
		outputs:
			n % 2 === 1
				? [out(value(ASSET, BigInt(n)), 0, "p color abc")]
				: [out(value(OTHER, 1n), 0, "p color abc")],
	});
	const walletOf = (total: number, calls: Partial<ListActionsArgs>[] = []) => {
		const actions = Array.from({ length: total }, (_, n) => actionAt(n));
		return {
			listActions: async (args: ListActionsArgs) => {
				calls.push(args);
				const offset = args.offset ?? 0;
				return {
					totalActions: total,
					actions: actions.slice(offset, offset + (args.limit ?? 10)),
				};
			},
		};
	};

	it("probes the total, then reads pages backwards with locking scripts", async () => {
		const calls: Partial<ListActionsArgs>[] = [];
		await fetchOneColorHistory(walletOf(150, calls), ASSET, { limit: 5 });
		assert.deepEqual(calls[0], { labels: [], limit: 1, offset: 0 });
		assert.deepEqual(calls[1], {
			labels: [],
			includeOutputs: true,
			includeOutputLockingScripts: true,
			includeInputs: true,
			includeInputSourceLockingScripts: true,
			limit: 100,
			offset: 50,
		});
		assert.equal(calls.length, 2);
	});

	it("returns matches newest first, skipping offset of them", async () => {
		const first = await fetchOneColorHistory(walletOf(20), ASSET, {
			limit: 3,
		});
		assert.deepEqual(
			first.map((e) => [e.direction, e.amount]),
			[
				["received", 19n],
				["received", 17n],
				["received", 15n],
			],
		);
		const second = await fetchOneColorHistory(walletOf(20), ASSET, {
			offset: 3,
			limit: 3,
		});
		assert.deepEqual(
			second.map((e) => e.action.description),
			["action 13", "action 11", "action 9"],
		);
	});

	it("crosses page boundaries and stops at the oldest action", async () => {
		const all = await fetchOneColorHistory(walletOf(250), ASSET, {
			limit: 1000,
		});
		assert.equal(all.length, 125);
		assert.equal(all.at(-1)?.amount, 1n);
	});

	it("defaults to one page of the history size", async () => {
		const page = await fetchOneColorHistory(walletOf(200), ASSET);
		assert.equal(page.length, ONE_COLOR_HISTORY_PAGE);
	});

	it("an empty wallet reads nothing past the probe", async () => {
		const calls: Partial<ListActionsArgs>[] = [];
		assert.deepEqual(await fetchOneColorHistory(walletOf(0, calls), ASSET), []);
		assert.equal(calls.length, 1);
	});
});
