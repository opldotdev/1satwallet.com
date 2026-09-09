import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publicAvatarUrl, publicDisplayName } from "@/lib/p2p-public-profile";

describe("public profile claims", () => {
	it("turns inscribed images into https content URLs and drops unsafe names", () => {
		assert.equal(
			publicAvatarUrl(`ord://${"ab".repeat(32)}.2`, "main"),
			`https://api.1sat.app/content/${"ab".repeat(32)}_2`,
		);
		assert.equal(
			publicAvatarUrl(`1sat://${"cd".repeat(32)}`, "test"),
			`https://testnet.api.1sat.app/content/${"cd".repeat(32)}_0`,
		);
		assert.equal(
			publicAvatarUrl("https://example.com/me.png?token=secret#x", "main"),
			"https://example.com/me.png",
		);
		assert.equal(publicAvatarUrl("javascript:alert(1)", "main"), undefined);
		assert.equal(publicDisplayName("  Alice  "), "Alice");
		assert.equal(publicDisplayName("Alice\nAdmin"), undefined);
		assert.equal(publicDisplayName("A".repeat(80)), "A".repeat(64));
		assert.equal(publicDisplayName("   "), undefined);
	});
});
