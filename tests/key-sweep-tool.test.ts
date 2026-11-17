import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const source = readFileSync(
	join(process.cwd(), "components/wallet/key-sweep-tool.tsx"),
	"utf8",
);

describe("key sweep tool", () => {
	it("sweeps only after a finished, error-free scan of the current keys", () => {
		assert.match(
			source,
			/const scanReady = assets\.scanned && !assets\.loading && !assets\.error;/,
		);
		assert.match(
			source,
			/if \(!keys \|\| !scanReady \|\| sweepCount === 0\) return;/,
		);
		assert.match(source, /disabled=\{!scanReady \|\| sweepCount === 0\}/);
	});

	it("logs under its own prefix and spells addresses right", () => {
		assert.match(source, /logPrefix: "\[sweep\]"/);
		assert.doesNotMatch(source, /plural\([^)]*"address"\)/);
	});
});
