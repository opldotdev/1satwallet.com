import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const heroSource = readFileSync(
	join(process.cwd(), "components/landing/hero.tsx"),
	"utf8",
);

describe("landing hero copy", () => {
	it("preserves the original P2P message", () => {
		assert.match(heroSource, /Satoshi's favorite asset wallet\./);
		assert.match(heroSource, /Trade with peers\./);
		assert.match(heroSource, /No servers\. No middleman\./);
		assert.doesNotMatch(heroSource, /soon™/);
		assert.doesNotMatch(heroSource, /One BRC-100 interface\./);
	});

	it("keeps the landing page focused on its trading canvas", () => {
		assert.doesNotMatch(heroSource, /EncryptionGrid/);
		assert.doesNotMatch(heroSource, /Feature Grid/);
		assert.doesNotMatch(heroSource, /min-h-\[100dvh\]/);
		assert.match(heroSource, /min-h-0 flex-1/);
		assert.match(heroSource, /P2P trading floor/);
	});
});
