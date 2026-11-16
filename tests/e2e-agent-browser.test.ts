import assert from "node:assert/strict";
import { test } from "node:test";
import { Browser } from "../e2e/support/agent-browser";

test("redacts every secret from driver messages", () => {
	const browser = new Browser(["s3cret-pass", '{"backup":1}']);
	assert.equal(
		browser.redact('typed s3cret-pass into {"backup":1} and s3cret-pass'),
		"typed [redacted] into [redacted] and [redacted]",
	);
});

test("refuses a fixed sleep before starting agent-browser", async () => {
	await assert.rejects(
		new Browser().run(["wait", "500"]),
		/fixed sleeps are banned/,
	);
});
