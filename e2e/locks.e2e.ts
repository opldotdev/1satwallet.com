import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/wallet";
import { CHAIN_TIMEOUT, readBalanceSats } from "./support/waits";

const locksRegion = (page: Page) =>
	page.getByRole("region", { name: "Locks", exact: true });

/** Opens "Lock BSV" with an amount entered. */
async function openLockDialog(page: Page, amount: string) {
	await locksRegion(page).getByRole("button", { name: "Lock BSV" }).click();
	const dialog = page.getByRole("dialog", { name: "Lock BSV" });
	await dialog.getByLabel("Amount (BSV)").fill(amount);
	return dialog;
}

async function loadedLocks(page: Page) {
	const region = locksRegion(page);
	await expect(region.getByText("Loading locks…")).toBeHidden({
		timeout: CHAIN_TIMEOUT,
	});
	await expect(
		region.getByText("Locks could not be loaded. Try again."),
	).toBeHidden();
	return region;
}

// Runs first: a lock from an earlier run whose block has passed is unlocked
// before this run adds its own one-block lock.
test("unlocks a matured lock from an earlier run", async ({ page }) => {
	const region = await loadedLocks(page);
	const matured = region
		.getByRole("listitem")
		.filter({
			has: page.getByRole("button", { name: "Unlock", exact: true }),
		})
		.filter({ hasNot: page.getByText("no wallet tracking record") });
	const count = await matured.count();
	if (count === 0) {
		if (process.env.E2E_REQUIRE_UNLOCK === "1") {
			throw new Error(
				"No matured lock to unlock, and E2E_REQUIRE_UNLOCK=1. The previous runs' one-block locks should have matured by now.",
			);
		}
		test.skip(true, "no matured lock; this run created one");
		return;
	}

	const before = await readBalanceSats(page);
	await matured
		.first()
		.getByRole("button", { name: "Unlock", exact: true })
		.click();
	await expect(
		region.getByText(/^Unlocked\. Transaction [0-9a-f]{64}$/),
	).toBeVisible({
		timeout: CHAIN_TIMEOUT,
	});
	await expect(matured).toHaveCount(count - 1, { timeout: CHAIN_TIMEOUT });
	await expect
		.poll(() => readBalanceSats(page), { timeout: CHAIN_TIMEOUT })
		.toBeGreaterThan(before);
});

test("locks 0.00001 BSV for one block", async ({ page }) => {
	await loadedLocks(page);
	const dialog = await openLockDialog(page, "0.00001");
	await dialog.getByRole("button", { name: "After blocks" }).click();
	await dialog.getByRole("textbox", { name: "Blocks from now" }).fill("1");
	await dialog.getByRole("button", { name: "Review lock" }).click();

	await expect(dialog.getByText("Unlocks at block")).toBeVisible({
		timeout: CHAIN_TIMEOUT,
	});
	await expect(dialog.getByText("0.00001000 BSV")).toBeVisible();
	await dialog.getByRole("button", { name: "Confirm and lock" }).click();

	const locked = page.getByRole("dialog", { name: "BSV locked" });
	await expect(locked).toBeVisible({ timeout: CHAIN_TIMEOUT });
	const description = await locked
		.getByText(/^It unlocks at block /)
		.textContent();
	const until = description?.match(/block ([\d,]+)\./)?.[1];
	if (!until) {
		throw new Error(`No unlock block in the success dialog: "${description}"`);
	}
	await locked.getByRole("button", { name: "Done" }).click();

	const region = locksRegion(page);
	const coin = region
		.getByRole("listitem")
		.filter({ hasText: `Unlock block ${until}` });
	await expect(async () => {
		await region.getByRole("button", { name: "Refresh locks" }).click();
		await expect(coin.first()).toBeVisible({ timeout: 5_000 });
	}).toPass({ timeout: CHAIN_TIMEOUT });
});

test("rejects a zero amount and a block that is not after the current height", async ({
	page,
}) => {
	await loadedLocks(page);

	const zero = await openLockDialog(page, "0");
	await zero.getByRole("button", { name: "Review lock" }).click();
	await expect(zero.getByRole("alert")).toHaveText(
		"Enter a positive BSV amount with no more than 8 decimals.",
		{ timeout: CHAIN_TIMEOUT },
	);
	await page.keyboard.press("Escape");
	await expect(zero).toBeHidden();

	const past = await openLockDialog(page, "0.00001");
	await past.getByRole("button", { name: "At block height" }).click();
	await past.getByRole("textbox", { name: "Unlock block height" }).fill("1");
	await past.getByRole("button", { name: "Review lock" }).click();
	await expect(past.getByRole("alert")).toHaveText(
		/^Pick a block after the current height, \d+\.$/,
		{ timeout: CHAIN_TIMEOUT },
	);
});
