import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Apple download offers the wallet invitation separately from TestFlight", () => {
	const html = readFileSync(
		new URL("../app/download/download-page-client.tsx", import.meta.url),
		"utf8",
	);
	const notice = readFileSync(
		new URL("../app/download/beta-notice.tsx", import.meta.url),
		"utf8",
	);
	const links = readFileSync(
		new URL("../app/download/links.ts", import.meta.url),
		"utf8",
	);
	assert.ok(links.includes('"https://testflight.apple.com/join/9N4jc7Qm"'));
	assert.equal(html.match(/href=\{TESTFLIGHT_URL\}/g)?.length, 1);
	assert.ok(html.includes('href="/wallet"'));
	assert.ok(!html.includes('href="/wallet/create"'));
	assert.ok(html.includes('href="mailto:luke@opl.dev"'));
	assert.ok(!html.includes("Find 1Sat Wallet in TestFlight"));
	assert.ok(notice.includes("permanent loss"));
	assert.ok(notice.includes("Dialog.Trigger"));
	assert.ok(notice.includes("Dialog.Close"));
	assert.ok(html.includes("/oneSatLogoDark.png"));
	assert.ok(html.includes("<MacPreview"));
	assert.ok(html.includes("Download beta"));
	assert.ok(!html.includes("Beta in review"));
	assert.ok(
		!html.includes("Public downloads open after Apple approves the beta"),
	);
});
