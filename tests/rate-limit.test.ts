import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRateLimited, withRateLimitRetry } from "@/lib/wallet/rate-limit";

const tooMany = () =>
	Object.assign(new Error("Received HTTP 429 from https://x"), {
		details: { status: 429 },
	});
const noSleep = async () => {};

describe("withRateLimitRetry", () => {
	it("retries a 429 after each pause and returns the later success", async () => {
		const slept: number[] = [];
		const logs: string[] = [];
		let calls = 0;
		const value = await withRateLimitRetry(
			"op",
			async () => {
				calls += 1;
				if (calls < 3) throw tooMany();
				return "ok";
			},
			{
				sleep: async (ms) => {
					slept.push(ms);
				},
				log: (message) => logs.push(message),
			},
		);
		assert.equal(value, "ok");
		assert.deepEqual(slept, [2000, 4000]);
		assert.equal(logs.length, 2);
		assert.match(logs[0] ?? "", /^\[op\] .*HTTP 429.*retry 1 of 3/);
	});

	it("throws the 429 once the retries run out", async () => {
		let calls = 0;
		await assert.rejects(
			withRateLimitRetry(
				"op",
				async () => {
					calls += 1;
					throw tooMany();
				},
				{ sleep: noSleep, log: () => {} },
			),
			/HTTP 429/,
		);
		assert.equal(calls, 4);
	});

	it("throws any other error at once", async () => {
		let calls = 0;
		await assert.rejects(
			withRateLimitRetry(
				"op",
				async () => {
					calls += 1;
					throw Object.assign(new Error("boom"), { details: { status: 500 } });
				},
				{ sleep: noSleep, log: () => {} },
			),
			/boom/,
		);
		assert.equal(calls, 1);
	});
});

describe("withRateLimitRetry cancel", () => {
	it("stops retrying once shouldContinue turns false", async () => {
		let calls = 0;
		let live = true;
		await assert.rejects(
			withRateLimitRetry(
				"op",
				async () => {
					calls += 1;
					throw tooMany();
				},
				{
					sleep: async () => {
						live = false;
					},
					log: () => {},
					shouldContinue: () => live,
				},
			),
			/HTTP 429/,
		);
		assert.equal(calls, 1);
	});
});

describe("isRateLimited", () => {
	it("reads the status or the message", () => {
		assert.equal(isRateLimited(tooMany()), true);
		assert.equal(isRateLimited(new Error("Received HTTP 429 Too Many")), true);
		assert.equal(isRateLimited(new Error("HTTP 4290")), false);
		assert.equal(isRateLimited(new Error("HTTP 500")), false);
		assert.equal(isRateLimited("429"), false);
	});
});
