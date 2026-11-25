import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { bsv21IconOutpoint, bsv21IconSrc } from "../lib/bsv21-icon";
import { STACK_URL, TEST_STACK_URL } from "../lib/stack";

const TXID = "87f1d0785cf9b4951e75e8cf9353d63a49f98e9b6b255bcd6a986db929a00472";
const TOKEN_ID = `${"ab".repeat(32)}_0`;

/** The source and transforms of an /api/image src. */
function parseImageSrc(src: string | undefined) {
	assert.ok(src, "expected an image src");
	assert.ok(src.startsWith("/api/image?"), src);
	const params = new URLSearchParams(src.slice("/api/image?".length));
	return {
		url: params.get("url"),
		w: params.get("w"),
		h: params.get("h"),
		fit: params.get("fit"),
		q: params.get("q"),
	};
}

describe("BSV-21 token icons", () => {
	it("renders a bare outpoint icon through OrdFS with resize transforms", () => {
		const src = bsv21IconSrc(TOKEN_ID, `${TXID}_0`, 80);
		assert.notEqual(src, `${TXID}_0`);
		assert.deepEqual(parseImageSrc(src), {
			url: `${STACK_URL}/content/${TXID}_0`,
			w: "80",
			h: "80",
			fit: null,
			q: "80",
		});
	});

	it("resolves _N to that output of the deploy transaction", () => {
		assert.equal(bsv21IconOutpoint(TOKEN_ID, "_2"), `${"ab".repeat(32)}_2`);
		assert.equal(
			parseImageSrc(bsv21IconSrc(TOKEN_ID, "_2", 128)).url,
			`${STACK_URL}/content/${"ab".repeat(32)}_2`,
		);
	});

	it("accepts txid.vout and upper case, emitting txid_vout", () => {
		assert.equal(
			bsv21IconOutpoint(TOKEN_ID, `${TXID.toUpperCase()}.3`),
			`${TXID}_3`,
		);
	});

	it("uses the testnet OrdFS on testnet", () => {
		assert.equal(
			parseImageSrc(bsv21IconSrc(TOKEN_ID, `${TXID}_0`, 80, "test")).url,
			`${TEST_STACK_URL}/content/${TXID}_0`,
		);
	});

	it("transforms trusted OrdFS URLs and drops anything else", () => {
		const ordfs = `https://ordfs.network/content/${TXID}_0`;
		assert.equal(parseImageSrc(bsv21IconSrc(TOKEN_ID, ordfs, 80)).url, ordfs);
		const originalError = console.error;
		const logged: unknown[][] = [];
		console.error = (...args: unknown[]) => logged.push(args);
		try {
			assert.equal(
				bsv21IconSrc(TOKEN_ID, "https://example.com/x.png", 80),
				undefined,
			);
			assert.equal(bsv21IconSrc(TOKEN_ID, "not-an-icon", 80), undefined);
			assert.equal(bsv21IconSrc(TOKEN_ID, "not-an-icon", 80), undefined);
		} finally {
			console.error = originalError;
		}
		assert.equal(logged.length, 2, "each unusable icon is logged once");
		assert.equal(bsv21IconSrc(TOKEN_ID, undefined, 80), undefined);
		assert.equal(bsv21IconSrc(TOKEN_ID, "", 80), undefined);
	});

	it("never hands a raw icon field to an image src", () => {
		const read = (path: string) =>
			readFileSync(join(process.cwd(), path), "utf8");
		const grid = read("components/wallet/token-grid.tsx");
		assert.match(grid, /bsv21IconSrc\(token\.id, token\.icon \|\| token\.id/);
		assert.doesNotMatch(grid, /token\.icon \|\| getOrdinalThumbnail/);
		assert.match(read("lib/hooks/use-legacy-assets.ts"), /bsv21IconSrc\(/);
		assert.match(
			read("app/(main)/market/bsv21/[tokenId]/page.tsx"),
			/bsv21IconSrc\(tokenId, details\.token\.icon/,
		);
		assert.match(read("components/wallet/token-row.tsx"), /onError=/);
	});
});
