import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LockingScript, Transaction } from "@bsv/sdk";
import {
	type ColorOverlayOverride,
	createColorOverlayProvider,
	isColorAssetId,
	NoColorOverlayError,
	normalizeOverlayOrigin,
} from "@/lib/wallet/color-overlay";

// Port of Yours (1color branch) src/services/colorOverlay.test.ts.

const ASSET_A = `${"a".repeat(64)}_0`;
const ASSET_B = `${"b".repeat(64)}_1`;
const DEFAULT = "https://testnet.openex.dev";
const OTHER = "https://overlay.example.com";

type Call = {
	url: string;
	method?: string;
	headers: Record<string, string>;
	body: unknown;
};

/** A fake fetch that records each request and answers JSON. */
const fakeFetch = (answer: unknown = { type: "output-list", outputs: [] }) => {
	const calls: Call[] = [];
	const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const body = init?.body;
		calls.push({
			url: String(input),
			method: init?.method,
			headers: Object.fromEntries(
				new Headers(init?.headers as HeadersInit).entries(),
			),
			body:
				body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : body,
		});
		return new Response(JSON.stringify(answer), {
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	return { fn, calls };
};

const provider = (
	overrides: ColorOverlayOverride[],
	defaultOrigin: string | undefined,
	fetchFn: typeof fetch,
) =>
	createColorOverlayProvider({
		defaultOrigin,
		getOverrides: async () => overrides,
		fetch: fetchFn,
	});

describe("color overlay origin resolution", () => {
	it("a per-token override wins over the default", async () => {
		const p = provider(
			[{ assetId: ASSET_A, origin: OTHER }],
			DEFAULT,
			fakeFetch().fn,
		);
		assert.equal(await p.resolveOrigin(ASSET_A), OTHER);
	});

	it("a token without an override uses the chain default", async () => {
		const p = provider(
			[{ assetId: ASSET_A, origin: OTHER }],
			DEFAULT,
			fakeFetch().fn,
		);
		assert.equal(await p.resolveOrigin(ASSET_B), DEFAULT);
	});

	it("no override and no default throws; no request is made", async () => {
		const f = fakeFetch();
		const p = provider([], undefined, f.fn);
		await assert.rejects(p.resolveOrigin(ASSET_A), NoColorOverlayError);
		await assert.rejects(p.spendability(ASSET_A, ["x.0"]), NoColorOverlayError);
		await assert.rejects(
			p.submit([`tm_color_${ASSET_A}`], [1, 2, 3]),
			NoColorOverlayError,
		);
		assert.equal(f.calls.length, 0);
	});

	it("overrides are read on every call", async () => {
		const overrides: ColorOverlayOverride[] = [];
		const p = provider(overrides, DEFAULT, fakeFetch().fn);
		assert.equal(await p.resolveOrigin(ASSET_A), DEFAULT);
		overrides.push({ assetId: ASSET_A, origin: OTHER });
		assert.equal(await p.resolveOrigin(ASSET_A), OTHER);
	});
});

describe("color overlay lookups", () => {
	it("spendability is a BRC-24 lookup at the origin root", async () => {
		const f = fakeFetch();
		const p = provider([], DEFAULT, f.fn);
		const answer = await p.spendability(ASSET_A, [`${"c".repeat(64)}.2`]);
		// The SDK parses the answer into a null-prototype object.
		assert.deepEqual({ ...answer }, { type: "output-list", outputs: [] });
		assert.equal(f.calls.length, 1);
		assert.equal(f.calls[0].url, `${DEFAULT}/lookup`);
		assert.equal(f.calls[0].method, "POST");
		assert.deepEqual(JSON.parse(f.calls[0].body as string), {
			service: `ls_color_${ASSET_A}`,
			query: {
				type: "color-spendability",
				version: 1,
				assetId: ASSET_A,
				topic: `tm_color_${ASSET_A}`,
				outpoints: [`${"c".repeat(64)}.2`],
			},
		});
	});

	it("admission asks color-admission at the override origin", async () => {
		const f = fakeFetch();
		const p = provider([{ assetId: ASSET_B, origin: OTHER }], DEFAULT, f.fn);
		await p.admission(ASSET_B, [`${"b".repeat(64)}.1`]);
		assert.equal(f.calls[0].url, `${OTHER}/lookup`);
		assert.equal(
			JSON.parse(f.calls[0].body as string).query.type,
			"color-admission",
		);
	});

	it("a freeform answer is an error, never an empty list", async () => {
		const f = fakeFetch({ type: "freeform", result: {} });
		const p = provider([], DEFAULT, f.fn);
		await assert.rejects(
			p.spendability(ASSET_A, ["x.0"]),
			/answered color-spendability with a freeform answer/,
		);
	});
});

describe("color overlay submit", () => {
	it("BRC-22 submit: BEEF body, comma-separated X-Topics, STEAK back", async () => {
		const steak = {
			[`tm_color_${ASSET_A}`]: { outputsToAdmit: [0], coinsToRetain: [] },
		};
		const f = fakeFetch(steak);
		const p = provider([], DEFAULT, f.fn);
		const result = await p.submit(
			[`tm_color_${ASSET_A}`, `tm_color_${ASSET_B}`],
			[1, 2, 3],
		);
		assert.deepEqual(result, steak);
		assert.equal(f.calls.length, 1);
		assert.equal(f.calls[0].url, `${DEFAULT}/submit`);
		assert.equal(
			f.calls[0].headers["x-topics"],
			`tm_color_${ASSET_A},tm_color_${ASSET_B}`,
		);
		assert.equal(
			f.calls[0].headers["content-type"],
			"application/octet-stream",
		);
		assert.deepEqual(Array.from(f.calls[0].body as Uint8Array), [1, 2, 3]);
	});

	it("topics of tokens on different overlays go to each overlay", async () => {
		const f = fakeFetch({});
		const p = provider([{ assetId: ASSET_B, origin: OTHER }], DEFAULT, f.fn);
		await p.submit([`tm_color_${ASSET_A}`, `tm_color_${ASSET_B}`], [9]);
		assert.deepEqual(
			f.calls.map((c) => [c.url, c.headers["x-topics"]]),
			[
				[`${DEFAULT}/submit`, `tm_color_${ASSET_A}`],
				[`${OTHER}/submit`, `tm_color_${ASSET_B}`],
			],
		);
	});

	it("a deploy goes to tm_color at the new asset's origin", async () => {
		const tx = new Transaction();
		tx.addOutput({
			lockingScript: LockingScript.fromASM("OP_TRUE"),
			satoshis: 1,
		});
		const beef = tx.toAtomicBEEF();
		const deployId = `${tx.id("hex")}_0`;
		const f = fakeFetch({});
		const p = provider([{ assetId: deployId, origin: OTHER }], DEFAULT, f.fn);
		await p.submit(["tm_color"], beef);
		assert.equal(f.calls[0].url, `${OTHER}/submit`);
		assert.equal(f.calls[0].headers["x-topics"], "tm_color");
	});

	it("an unknown topic is refused", async () => {
		const f = fakeFetch();
		const p = provider([], DEFAULT, f.fn);
		await assert.rejects(p.submit(["tm_other"], [1]), /unexpected topic/);
		assert.equal(f.calls.length, 0);
	});
});

describe("color overlay helpers", () => {
	it("normalizeOverlayOrigin keeps the https origin only", () => {
		assert.equal(
			normalizeOverlayOrigin(" https://Testnet.OpenEx.dev/lookup?x=1 "),
			"https://testnet.openex.dev",
		);
		assert.equal(
			normalizeOverlayOrigin("http://testnet.openex.dev"),
			undefined,
		);
		assert.equal(
			normalizeOverlayOrigin("https://user:pass@testnet.openex.dev"),
			undefined,
		);
		assert.equal(normalizeOverlayOrigin("not a url"), undefined);
	});

	it("isColorAssetId accepts <txid>_<vout> only", () => {
		assert.equal(isColorAssetId(ASSET_A), true);
		assert.equal(isColorAssetId(`${"A".repeat(64)}_0`), false);
		assert.equal(isColorAssetId(`${"a".repeat(64)}.0`), false);
		assert.equal(isColorAssetId("a_0"), false);
	});
});
