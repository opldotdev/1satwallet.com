import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	groupUnconfirmedBsv20,
	parseBsv20Content,
	UNKNOWN_TICK,
} from "@/lib/wallet/bsv20-content";

describe("parseBsv20Content", () => {
	it("reads a BSV-20 mint", () => {
		assert.deepEqual(
			parseBsv20Content(
				'{"p":"bsv-20","op":"mint","tick":"ZOID","amt":"10000"}',
			),
			{ tick: "ZOID", op: "mint", amt: "10000" },
		);
	});

	it("uppercases and trims the ticker and drops an odd amount", () => {
		assert.deepEqual(
			parseBsv20Content(
				'{"p":"bsv-20","op":"transfer","tick":" zoid ","amt":"1e9"}',
			),
			{ tick: "ZOID", op: "transfer", amt: null },
		);
	});

	it("rejects anything else", () => {
		for (const text of [
			'{"p":"bsv-21","op":"transfer","id":"x_0","amt":"1"}',
			"<html><body>hi</body></html>",
			"not json",
			'{"p":"bsv-20","op":"mint","amt":"1"}',
			'{"p":"bsv-20","tick":""}',
			`{"p":"bsv-20","tick":"${"A".repeat(40)}"}`,
			`{"p":"bsv-20","tick":"ZOID","pad":"${"x".repeat(5000)}"}`,
			"[1,2]",
		]) {
			assert.equal(parseBsv20Content(text), null, text.slice(0, 40));
		}
	});
});

describe("groupUnconfirmedBsv20", () => {
	const z = parseBsv20Content(
		'{"p":"bsv-20","op":"mint","tick":"ZOID","amt":"5"}',
	);
	const zLower = parseBsv20Content('{"p":"bsv-20","op":"mint","tick":"zoid"}');
	const p = parseBsv20Content('{"p":"bsv-20","op":"mint","tick":"PEPE"}');

	it("groups by ticker across case, most outputs first, Unknown last", () => {
		const groups = groupUnconfirmedBsv20([
			{ outpoint: "a_0", content: p },
			{ outpoint: "b_0", content: null },
			{ outpoint: "c_0", content: z },
			{ outpoint: "d_0", content: zLower },
		]);
		assert.deepEqual(
			groups.map((g) => [g.tick, g.outputs]),
			[
				["ZOID", 2],
				["PEPE", 1],
				[UNKNOWN_TICK, 1],
			],
		);
		assert.deepEqual(groups[0].entries[0], {
			outpoint: "c_0",
			op: "mint",
			amt: "5",
		});
	});

	it("leaves the top-five cut to the screen, keeping every group", () => {
		const entries = ["A", "B", "C", "D", "E", "F", "G"].map((tick, i) => ({
			outpoint: `${i}_0`,
			content: parseBsv20Content(`{"p":"bsv-20","op":"mint","tick":"${tick}"}`),
		}));
		assert.equal(groupUnconfirmedBsv20(entries).length, 7);
	});
});
