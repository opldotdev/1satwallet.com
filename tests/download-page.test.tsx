import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppleAppPage } from "../app/(main)/download/download-page-client";

test("Apple download offers the wallet invitation separately from TestFlight", () => {
	const html = renderToStaticMarkup(<AppleAppPage />);
	assert.equal(
		html.match(/href="https:\/\/testflight.apple.com\/join\/9N4jc7Qm"/g)
			?.length,
		3,
	);
	assert.ok(
		html.includes('href="https://apps.apple.com/app/testflight/id899247664"'),
	);
	assert.ok(html.includes("Accept the invitation"));
	assert.ok(!html.includes("Find 1Sat Wallet in TestFlight"));
});
