import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/wallet";
import { CHAIN_TIMEOUT } from "./support/waits";

/** A per-run value, so every run publishes a real change. */
const runId = process.env.GITHUB_RUN_ID ?? String(Date.now());

// Production serves this image publicly; the query makes the value per-run.
const bannerUrl = `https://1satwallet.com/images/wallet/radar.png?e2e=${runId}`;

/** Client-side navigation keeps the unlocked session (a reload locks it). */
async function openProfile(page: Page) {
	await page.getByRole("tab", { name: "Identity", exact: true }).click();
	await expect(page).toHaveURL(/\/wallet\/identity$/);
	await expect(page.getByLabel("Public bio")).toBeVisible({
		timeout: CHAIN_TIMEOUT,
	});
}

test("saves the public bio and banner, and reads them back after a reload", async ({
	page,
	wallet,
}) => {
	const bio = `1satwallet.com e2e run ${runId}`;
	await openProfile(page);
	await page.getByLabel("Public bio").fill(bio);
	await page.getByLabel("Banner", { exact: true }).fill(bannerUrl);
	await expect(page.getByRole("img", { name: "Banner preview" })).toBeVisible();

	await page
		.getByRole("button", { name: "Review profile transaction" })
		.click();
	const review = page.getByRole("dialog", {
		name: "Review public profile transaction",
	});
	await expect(review.getByText(bio)).toBeVisible();
	await expect(review.getByText(bannerUrl)).toBeVisible();
	await review
		.getByRole("button", { name: "Request wallet authorization" })
		.click();
	await expect(
		page.getByText(/^Profile transaction [0-9a-f]{64}\./),
	).toBeVisible({ timeout: CHAIN_TIMEOUT });

	await page.reload();
	await wallet.unlock();
	await expect(page.getByLabel("Public bio")).toHaveValue(bio, {
		timeout: CHAIN_TIMEOUT,
	});
	await expect(page.getByLabel("Banner", { exact: true })).toHaveValue(
		bannerUrl,
	);
	await expect(page.getByRole("img", { name: "Banner preview" })).toBeVisible();
});

test("rejects a non-https banner URL", async ({ page }) => {
	await openProfile(page);
	const banner = page.getByLabel("Banner", { exact: true });
	await banner.fill("http://example.com/banner.png");
	await expect(banner).toHaveAttribute("aria-invalid", "true");
	await expect(
		page.getByText("Use an https://, ord://, or 1sat:// image URL."),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Review profile transaction" }),
	).toBeDisabled();
});

test("the banner ordinal picker shows its empty state", async ({ page }) => {
	await openProfile(page);
	// Avatar comes first, then Banner; the dialog title confirms which opened.
	await page
		.getByRole("button", { name: "Pick from my ordinals" })
		.nth(1)
		.click();
	const picker = page.getByRole("dialog", { name: "Choose a banner" });
	await expect(picker).toBeVisible();
	await expect(
		picker.getByText("No image ordinals in this wallet."),
	).toBeVisible({ timeout: CHAIN_TIMEOUT });
});
