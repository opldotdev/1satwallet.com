import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppleAppPage } from "../app/(main)/download/download-page-client";

test("Apple download offers the wallet invitation separately from TestFlight", () => {
	const html = renderToStaticMarkup(<AppleAppPage />);
	expect(
		html.match(/href="https:\/\/testflight.apple.com\/join\/9N4jc7Qm"/g),
	).toHaveLength(3);
	expect(html).toContain(
		'href="https://apps.apple.com/app/testflight/id899247664"',
	);
	expect(html).toContain("Accept the invitation");
	expect(html).not.toContain("Find 1Sat Wallet in TestFlight");
});
