import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import PrivacyPage, { metadata } from "../app/(main)/privacy/page";

test("privacy policy renders without a wallet and provides a contact", () => {
	const html = renderToStaticMarkup(<PrivacyPage />);
	assert.equal(metadata.title, "Privacy Policy | 1Sat Wallet");
	for (const text of [
		"Apple Keychain",
		"browser storage",
		"Convex",
		"public",
		"Retention and deletion",
		"mailto:luke@opl.dev",
	]) {
		assert.ok(html.includes(text), `Missing privacy disclosure: ${text}`);
	}
});
