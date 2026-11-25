import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const heroSource = readFileSync(
	join(process.cwd(), "components/landing/hero.tsx"),
	"utf8",
);

describe("landing hero copy", () => {
	it("carries no marketing copy: it is the wallet", () => {
		assert.doesNotMatch(heroSource, /Satoshi's favorite/);
		assert.doesNotMatch(heroSource, /Trade with peers/);
		assert.doesNotMatch(heroSource, /No servers/);
		assert.doesNotMatch(heroSource, /to enter/);
		assert.doesNotMatch(heroSource, /<p\b/);
		assert.match(heroSource, /<WalletHome \/>/);
		assert.doesNotMatch(heroSource, /soon™/);
		assert.doesNotMatch(heroSource, /One BRC-100 interface\./);
	});

	it("keeps the landing page focused on its trading canvas", () => {
		assert.doesNotMatch(heroSource, /EncryptionGrid/);
		assert.doesNotMatch(heroSource, /Feature Grid/);
		assert.doesNotMatch(heroSource, /min-h-\[100dvh\]/);
		assert.match(heroSource, /min-h-0 flex-1/);
		assert.doesNotMatch(heroSource, /floor-note/);
		assert.match(heroSource, /<WalletConnectCarousel \/>/);
		assert.match(heroSource, /Unlock wallet/);
		assert.match(heroSource, /barShown \? "pb-28" : "pb-8"/);
		assert.doesNotMatch(heroSource, /Popover/);
	});
});
