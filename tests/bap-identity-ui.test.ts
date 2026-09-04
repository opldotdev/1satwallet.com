import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const bapSource = readFileSync(
	join(process.cwd(), "components/wallet/bap-identity-center.tsx"),
	"utf8",
);

describe("bap dynamic error announcements", () => {
	it("announces review, search, and profile read errors as alerts", () => {
		assert.match(bapSource, /role="alert"[\s\S]{0,120}\{reviewError\}/);
		assert.match(
			bapSource,
			/The BAP index search failed[\s\S]{0,120}role="alert"|role="alert"[\s\S]{0,120}The BAP index search failed/,
		);
		assert.match(
			bapSource,
			/The wallet identity could not be read safely[\s\S]{0,120}role="alert"|role="alert"[\s\S]{0,120}The wallet identity could not be read safely/,
		);
	});
});

describe("bap dynamic status announcements", () => {
	it("uses polite status semantics for loading, unavailable, empty, and range messages", () => {
		for (const message of [
			"Loading wallet identity",
			"Reading wallet identity",
			"Searching the public",
			"Checking stack capabilities",
			"No indexed identities matched this page",
			"Results \\{offset",
		]) {
			const index = bapSource.search(new RegExp(message));
			assert.ok(index >= 0, `expected message: ${message}`);
			const window = bapSource.slice(Math.max(0, index - 400), index + 200);
			assert.match(window, /role="status"/);
			assert.match(window, /aria-live="polite"/);
		}
	});
});

describe("bap live-region hygiene", () => {
	it("keeps StatusMessage as the single permanently mounted polite status region", () => {
		assert.match(bapSource, /function StatusMessage/);
		assert.match(bapSource, /aria-atomic="true"/);
		assert.match(bapSource, /aria-live="polite"/);
		assert.match(bapSource, /role="status"/);
		assert.equal(bapSource.match(/function StatusMessage/g)?.length, 1);
	});
	it("leaves static explanatory copy without live-region noise", () => {
		assert.match(
			bapSource,
			/<p className="text-muted-foreground text-xs">\s*Every non-empty/,
		);
	});
});
