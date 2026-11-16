import type { Browser } from "./support/agent-browser";
import { containing, type Locator, pattern } from "./support/page-query";
import { CHAIN_TIMEOUT, unlockWallet, walletTest } from "./support/wallet";

/** A per-run value, so every run publishes a real change. */
const runId = process.env.GITHUB_RUN_ID ?? String(Date.now());

// Production serves this image publicly; the query makes the value per-run.
const bannerUrl = `https://1satwallet.com/images/wallet/radar.png?e2e=${runId}`;

const bio: Locator = { role: "textbox", name: "Public bio" };
const banner: Locator = { role: "textbox", name: "Banner" };
const bannerPreview: Locator = { role: "img", name: "Banner preview" };
const reviewButton: Locator = {
	role: "button",
	name: "Review profile transaction",
};

/** Client-side navigation keeps the unlocked session (a reload locks it). */
async function openProfile(browser: Browser) {
	await browser.click({ role: "tab", name: "Identity" });
	await browser.waitFor(
		"the Identity tab URL",
		() => location.pathname.endsWith("/wallet/identity"),
		null,
	);
	await browser.waitUntil(
		"the profile form",
		bio,
		undefined,
		undefined,
		CHAIN_TIMEOUT,
	);
}

walletTest(
	"saves the public bio and banner, and reads them back after a reload",
	async (browser) => {
		const text = `1satwallet.com e2e run ${runId}`;
		await openProfile(browser);
		await browser.fill(bio, text);
		await browser.fill(banner, bannerUrl);
		await browser.waitUntil("the banner preview", bannerPreview);

		await browser.click(reviewButton);
		const review: Locator = {
			role: "dialog",
			name: "Review public profile transaction",
		};
		for (const value of [text, bannerUrl]) {
			await browser.waitUntil(`"${value}" in the review`, {
				role: "any",
				text: containing(value),
				within: review,
			});
		}
		await browser.click({
			role: "button",
			name: "Request wallet authorization",
			within: review,
		});
		await browser.waitUntil(
			"the profile transaction",
			{ role: "any", text: pattern(/^Profile transaction [0-9a-f]{64}\./) },
			undefined,
			undefined,
			CHAIN_TIMEOUT,
		);

		await browser.reload();
		await unlockWallet(browser);
		await browser.waitUntil(
			"the saved bio after a reload",
			bio,
			(result, expected) => result.value === expected,
			text,
			CHAIN_TIMEOUT,
		);
		const saved = await browser.query(banner);
		if (saved.value !== bannerUrl) {
			throw new Error(
				`The banner did not survive a reload: "${saved.value}", expected "${bannerUrl}".`,
			);
		}
		await browser.waitUntil("the banner preview after a reload", bannerPreview);
	},
);

walletTest("rejects a non-https banner URL", async (browser) => {
	await openProfile(browser);
	await browser.fill(banner, "http://example.com/banner.png");
	await browser.waitUntil("the banner field to be marked invalid", {
		role: "any",
		text: containing("Use an https://, ord://, or 1sat:// image URL."),
	});
	const field = await browser.query(banner, ["aria-invalid"]);
	if (field.attributes["aria-invalid"] !== "true") {
		throw new Error("The banner field is not marked aria-invalid.");
	}
	const button = await browser.query(reviewButton);
	if (button.disabled !== true) {
		throw new Error("Review profile transaction is enabled with a bad banner.");
	}
});

walletTest(
	"the banner ordinal picker shows its empty state",
	async (browser) => {
		await openProfile(browser);
		// Avatar comes first, then Banner; the dialog title confirms which opened.
		await browser.click({
			role: "button",
			name: "Pick from my ordinals",
			index: 1,
		});
		const picker: Locator = { role: "dialog", name: "Choose a banner" };
		await browser.waitUntil(
			"the empty state of the banner picker",
			{
				role: "any",
				text: containing("No image ordinals in this wallet."),
				within: picker,
			},
			undefined,
			undefined,
			CHAIN_TIMEOUT,
		);
	},
);
