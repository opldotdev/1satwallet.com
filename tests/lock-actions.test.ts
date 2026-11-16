import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { OneSatContext } from "@1sat/actions";
import {
	approximateBlockDuration,
	executeLock,
	executeUnlock,
	LOCKTIME_THRESHOLD,
	type LockActionSet,
	type LockedCoin,
	listLockedCoins,
	lockActionFailureMessage,
	lockRequestProblem,
	parseBlockNumber,
	resolveLockUntil,
} from "@/lib/wallet/lock-actions";

const ctx = { chain: "main" } as unknown as OneSatContext;
const txid = "ab".repeat(32);

function recordingActions(
	overrides: Partial<LockActionSet> = {},
): LockActionSet & { calls: Array<{ action: string; input: unknown }> } {
	const calls: Array<{ action: string; input: unknown }> = [];
	return {
		calls,
		list: async (_ctx, input) => {
			calls.push({ action: "list", input });
			return { outputs: [] };
		},
		lock: async (_ctx, input) => {
			calls.push({ action: "lock", input });
			return { txid };
		},
		unlock: async (_ctx, input) => {
			calls.push({ action: "unlock", input });
			return { txid };
		},
		...overrides,
	};
}

const coin = (overrides: Partial<LockedCoin> = {}): LockedCoin => ({
	id: "action1_0",
	outpoint: `${txid}.0`,
	satoshis: 5000,
	until: 900_000,
	spendable: true,
	...overrides,
});

describe("lock height input", () => {
	it("parses only positive whole block numbers", () => {
		assert.equal(parseBlockNumber("144"), 144);
		assert.equal(parseBlockNumber(" 900000 "), 900_000);
		for (const invalid of ["", "0", "012", "1.5", "-1", "1e3", "abc"]) {
			assert.equal(parseBlockNumber(invalid), null, invalid);
		}
	});

	it("resolves a duration from the current height and a height as typed", () => {
		assert.equal(resolveLockUntil("blocks", "144", 900_000), 900_144);
		assert.equal(resolveLockUntil("height", "900500", 900_000), 900_500);
		assert.equal(resolveLockUntil("blocks", "0", 900_000), null);
	});

	it("describes durations in hours and days", () => {
		assert.equal(approximateBlockDuration(3), "under an hour");
		assert.equal(approximateBlockDuration(6), "about 1 hour");
		assert.equal(approximateBlockDuration(144), "about 1 day");
		assert.equal(approximateBlockDuration(1008), "about 7 days");
	});
});

describe("lock request validation", () => {
	const valid = { satoshis: 1000, until: 900_001, currentHeight: 900_000 };

	it("accepts a positive amount and a future block", () => {
		assert.equal(lockRequestProblem(valid), null);
		assert.equal(lockRequestProblem({ ...valid, spendable: 1000 }), null);
	});

	it("rejects bad amounts", () => {
		for (const satoshis of [null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			assert.match(
				lockRequestProblem({ ...valid, satoshis }) ?? "",
				/positive BSV amount/,
				String(satoshis),
			);
		}
		assert.match(
			lockRequestProblem({ ...valid, spendable: 999 }) ?? "",
			/spendable balance/,
		);
	});

	it("rejects the current block, past blocks and timestamp-range heights", () => {
		assert.match(
			lockRequestProblem({ ...valid, until: 900_000 }) ?? "",
			/after the current height, 900000/,
		);
		assert.match(
			lockRequestProblem({ ...valid, until: 1 }) ?? "",
			/after the current height/,
		);
		assert.match(
			lockRequestProblem({ ...valid, until: LOCKTIME_THRESHOLD }) ?? "",
			/below 500000000/,
		);
		assert.match(
			lockRequestProblem({ ...valid, until: null }) ?? "",
			/whole number of blocks/,
		);
	});
});

describe("lock action dispatch", () => {
	it("passes the exact lock request to lockBsv", async () => {
		const actions = recordingActions();
		assert.equal(
			await executeLock(
				ctx,
				{ satoshis: 12_345, until: 900_144, currentHeight: 900_000 },
				actions,
			),
			txid,
		);
		assert.deepEqual(actions.calls, [
			{
				action: "lock",
				input: { requests: [{ satoshis: 12_345, until: 900_144 }] },
			},
		]);
	});

	it("validates before calling the wallet", async () => {
		const actions = recordingActions();
		await assert.rejects(
			executeLock(
				ctx,
				{ satoshis: 0, until: 900_144, currentHeight: 900_000 },
				actions,
			),
			/invalid-satoshis/,
		);
		await assert.rejects(
			executeLock(
				ctx,
				{ satoshis: 1, until: 900_000, currentHeight: 900_000 },
				actions,
			),
			/invalid-block-height/,
		);
		assert.deepEqual(actions.calls, []);
	});

	it("turns an action error or missing txid into a thrown code", async () => {
		await assert.rejects(
			executeLock(
				ctx,
				{ satoshis: 1, until: 900_001, currentHeight: 900_000 },
				recordingActions({
					lock: async () => ({ error: "Insufficient funds" }),
				}),
			),
			/Insufficient funds/,
		);
		await assert.rejects(
			executeUnlock(
				ctx,
				[coin()],
				recordingActions({ unlock: async () => ({}) }),
			),
			/no-txid-returned/,
		);
	});

	it("unlocks only the chosen spendable coins by tracking id", async () => {
		const actions = recordingActions();
		assert.equal(
			await executeUnlock(
				ctx,
				[coin(), coin({ id: "action2_1", outpoint: `${txid}.1` })],
				actions,
			),
			txid,
		);
		assert.deepEqual(actions.calls, [
			{ action: "unlock", input: { ids: ["action1_0", "action2_1"] } },
		]);
	});

	it("never asks unlockBsv to unlock everything", async () => {
		const actions = recordingActions();
		await assert.rejects(executeUnlock(ctx, [], actions), /lock-ids-required/);
		await assert.rejects(
			executeUnlock(ctx, [coin({ spendable: false })], actions),
			/lock-not-spendable/,
		);
		await assert.rejects(
			executeUnlock(ctx, [coin({ id: null })], actions),
			/locks-missing-id-or-ci/,
		);
		assert.deepEqual(actions.calls, []);
	});

	it("lists lock outputs with heights, ids and spendability, soonest first", async () => {
		const actions = recordingActions({
			list: async (_ctx, input) => {
				assert.deepEqual(input, { includeTags: true, limit: 10000 });
				return {
					outputs: [
						{
							outpoint: `${txid}.1`,
							satoshis: 300,
							spendable: true,
							tags: ["until:900100", "id:b_1"],
						},
						{
							outpoint: `${txid}.0`,
							satoshis: 200,
							spendable: true,
							tags: ["id:a_0", "until:900000"],
						},
						{
							outpoint: `${txid}.2`,
							satoshis: 100,
							spendable: true,
							tags: ["until:abc"],
						},
						{
							outpoint: `${txid}.3`,
							satoshis: 50,
							spendable: true,
							tags: ["until:899999"],
						},
					],
				};
			},
		});
		assert.deepEqual(await listLockedCoins(ctx, 900_000, actions), [
			{
				id: null,
				outpoint: `${txid}.3`,
				satoshis: 50,
				until: 899_999,
				spendable: true,
			},
			{
				id: "a_0",
				outpoint: `${txid}.0`,
				satoshis: 200,
				until: 900_000,
				spendable: true,
			},
			{
				id: "b_1",
				outpoint: `${txid}.1`,
				satoshis: 300,
				until: 900_100,
				spendable: false,
			},
		]);
	});
});

describe("lock failure messages", () => {
	it("maps SDK error codes to plain sentences", () => {
		assert.match(
			lockActionFailureMessage(new Error("no-matured-locks")),
			/can be unlocked yet/,
		);
		assert.match(
			lockActionFailureMessage("services-required"),
			/aren't available/,
		);
		assert.match(
			lockActionFailureMessage(new Error("invalid-block-height")),
			/valid unlock block/,
		);
		assert.match(
			lockActionFailureMessage(new Error("locks-missing-id-or-ci")),
			/no wallet tracking record/,
		);
	});

	it("maps wallet refusals and low funds", () => {
		assert.match(
			lockActionFailureMessage(new Error("User denied the request")),
			/declined/,
		);
		assert.match(
			lockActionFailureMessage(new Error("Insufficient funds: need 10")),
			/enough spendable BSV/,
		);
		assert.match(
			lockActionFailureMessage(new Error("socket hang up")),
			/lock action failed/,
		);
	});
});

describe("lock dialog lifecycle", () => {
	const source = readFileSync(
		join(process.cwd(), "components/wallet/wallet-locks.tsx"),
		"utf8",
	);

	it("closes through one reset path for Done, X and the overlay", () => {
		const close = source.slice(
			source.indexOf("const close = () => {"),
			source.indexOf("return (", source.indexOf("const close = () => {")),
		);
		assert.match(close, /if \(inFlightRef\.current\) return;/);
		assert.match(close, /setOpen\(false\)/);
		assert.match(close, /setState\(\{ status: "idle" \}\)/);
		assert.match(
			source,
			/onOpenChange=\{\(next\) => \(next \? setOpen\(true\) : close\(\)\)\}/,
		);
		assert.match(source, /onClick=\{close\}/);
		assert.doesNotMatch(source, /setOpen\(false\)\}/);
	});

	it("releases the in-flight guard before the post-lock refresh", () => {
		const success = source.slice(
			source.indexOf('play("success");'),
			source.indexOf("} catch (cause) {", source.indexOf('play("success");')),
		);
		assert.match(success, /inFlightRef\.current = false;\s*void onLocked\(\);/);
	});
});
