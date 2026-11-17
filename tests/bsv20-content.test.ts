import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	readBsv20Content,
	readBsv20Contents,
} from "@/lib/hooks/use-bsv20-content";
import {
	BSV20_UNREADABLE,
	type Bsv20Content,
	type Bsv20Read,
	groupUnconfirmedBsv20,
	isBsv20ContentType,
	parseBsv20Content,
	UNREADABLE_TICK,
} from "@/lib/wallet/bsv20-content";

const readOf = (content: Bsv20Content | null, reason = "x"): Bsv20Read =>
	content ? { content } : { content: null, reason };

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

	it("groups by ticker across case, most outputs first, Unreadable last", () => {
		const groups = groupUnconfirmedBsv20([
			{ outpoint: "a_0", read: readOf(p) },
			{ outpoint: "b_0", read: readOf(null, BSV20_UNREADABLE.notBsv20) },
			{ outpoint: "c_0", read: readOf(z) },
			{ outpoint: "d_0", read: readOf(zLower) },
		]);
		assert.deepEqual(
			groups.map((g) => [g.tick, g.outputs]),
			[
				["ZOID", 2],
				["PEPE", 1],
				[UNREADABLE_TICK, 1],
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
			read: readOf(
				parseBsv20Content(`{"p":"bsv-20","op":"mint","tick":"${tick}"}`),
			),
		}));
		assert.equal(groupUnconfirmedBsv20(entries).length, 7);
	});
});

describe("Unreadable group", () => {
	it("says why each unreadable output couldn't be read, most common first", () => {
		const groups = groupUnconfirmedBsv20([
			{ outpoint: "a_0", read: readOf(null, BSV20_UNREADABLE.http(404)) },
			{ outpoint: "b_0", read: readOf(null, BSV20_UNREADABLE.notBsv20) },
			{ outpoint: "c_0", read: readOf(null, BSV20_UNREADABLE.notBsv20) },
		]);
		assert.equal(groups.length, 1);
		assert.equal(groups[0].tick, "Unreadable");
		assert.deepEqual(groups[0].reasons, [
			{ reason: "its content isn't a BSV-20 inscription", outputs: 2 },
			{ reason: "the content server answered HTTP 404", outputs: 1 },
		]);
	});
});

// The content server's real answer for a BSV-20 mint (curl -sI
// https://api.1sat.app/content/7879395073affe4455852c5793ac199ab5cff360744d3b5bdd2247aef2fcea2a_0,
// 2026-11-17): content-type application/bsv-20, content-length 71.
const ZOID_MINT_BODY = `{
  "p": "bsv-20",
  "op": "mint",
  "tick": "ZOID",
  "amt": "10000"
}`;
const served = (body: string, contentType: string | null, status = 200) =>
	(async () =>
		new Response(body, {
			status,
			headers: contentType ? { "content-type": contentType } : {},
		})) as unknown as typeof fetch;

describe("reading BSV-20 content", () => {
	const signal = new AbortController().signal;
	const ZOID =
		"7879395073affe4455852c5793ac199ab5cff360744d3b5bdd2247aef2fcea2a_0";

	it("reads content served as application/bsv-20", async () => {
		assert.equal(isBsv20ContentType("application/bsv-20"), true);
		assert.deepEqual(
			await readBsv20Content(
				ZOID,
				signal,
				served(ZOID_MINT_BODY, "application/bsv-20"),
			),
			{ content: { tick: "ZOID", op: "mint", amt: "10000" } },
		);
	});

	it("still reads JSON and plain text, and names any other type", async () => {
		for (const type of [
			"application/json",
			"application/json; charset=utf-8",
			"text/plain;charset=utf-8",
		]) {
			assert.equal(isBsv20ContentType(type), true, type);
			assert.equal(
				(await readBsv20Content(ZOID, signal, served(ZOID_MINT_BODY, type)))
					.content?.tick,
				"ZOID",
			);
		}
		assert.deepEqual(
			await readBsv20Content(ZOID, signal, served("<svg/>", "image/svg+xml")),
			{ content: null, reason: "its content is image/svg+xml, not BSV-20" },
		);
		assert.deepEqual(
			await readBsv20Content(ZOID, signal, served("", "text/plain", 404)),
			{ content: null, reason: "the content server answered HTTP 404" },
		);
		// A server error is marked passing, so it isn't kept as the answer.
		assert.deepEqual(
			await readBsv20Content(ZOID, signal, served("", "text/plain", 503)),
			{
				content: null,
				reason: "the content server answered HTTP 503",
				transient: true,
			},
		);
	});

	it("checks every output, with no cap on how many", async () => {
		const outpoints = Array.from({ length: 521 }, (_, i) => `${i}_0`);
		const read = new Set<string>();
		let inFlight = 0;
		let peak = 0;
		await readBsv20Contents(outpoints, {
			concurrency: 6,
			signal,
			read: async () => {
				inFlight++;
				peak = Math.max(peak, inFlight);
				await new Promise((resolve) => setTimeout(resolve, 0));
				inFlight--;
				return readOf(null, BSV20_UNREADABLE.notBsv20);
			},
			onRead: (outpoint) => read.add(outpoint),
		});
		assert.equal(read.size, 521);
		assert.ok(peak <= 6, `at most 6 requests at once, saw ${peak}`);
	});

	it("stops reading once aborted", async () => {
		const controller = new AbortController();
		const read: string[] = [];
		await readBsv20Contents(["a_0", "b_0", "c_0"], {
			concurrency: 1,
			signal: controller.signal,
			read: async (outpoint) => {
				controller.abort();
				return readOf(null, outpoint);
			},
			onRead: (outpoint) => read.push(outpoint),
		});
		assert.deepEqual(read, []);
	});
});
