import { expect, type Locator, type Page } from "@playwright/test";

/** For assertions that follow a broadcast or a sync. */
export const CHAIN_TIMEOUT = 60_000;

export const TESTNET_BADGE_LABEL = "Testnet account. Coins have no real value.";

export const unlockDialog = (page: Page): Locator =>
	page.getByRole("dialog", { name: "Unlock wallet" });

/**
 * Sets a controlled input's value in the page. Unlike fill/type, an evaluate
 * step does not print its argument in the HTML report, which is public.
 */
function setInputValue(element: Element, value: string): void {
	if (!(element instanceof HTMLInputElement)) {
		throw new Error("Expected an input element");
	}
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)?.set;
	if (!setter) throw new Error("Input value setter is unavailable");
	setter.call(element, value);
	element.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Enters the passphrase into the app's unlock screen and waits for it to go. */
export async function unlockWallet(page: Page, passphrase: string) {
	const dialog = unlockDialog(page);
	await expect(dialog).toBeVisible({ timeout: CHAIN_TIMEOUT });
	const input = dialog.locator("#passphrase");
	await input.evaluate(setInputValue, passphrase);
	await dialog.getByRole("button", { name: "Unlock", exact: true }).click();
	try {
		await expect(dialog).toBeHidden({ timeout: CHAIN_TIMEOUT });
	} catch (error) {
		// Clear the field before the failure screenshot and page snapshot.
		const clearError = await input.evaluate(setInputValue, "").then(
			() => null,
			(cause: unknown) => cause,
		);
		const shown = (await dialog.textContent())?.trim() ?? "";
		throw new Error(`The wallet did not unlock. Unlock screen: "${shown}"`, {
			cause: clearError ? new AggregateError([error, clearError]) : error,
		});
	}
}

const addressSync = (page: Page) =>
	page.locator('[data-testid="wallet-sync-state"][data-task="addresses"]');

/** Wallet home is usable: balance rendered and the first address sync done. */
export async function waitForWalletReady(page: Page) {
	await expect(unlockDialog(page)).toBeHidden();
	await expect(page.getByTestId("wallet-balance")).toHaveAttribute(
		"data-sats",
		/^\d+$/,
		{ timeout: CHAIN_TIMEOUT },
	);
	const sync = addressSync(page);
	await expect(sync).toHaveAttribute("data-state", /^(succeeded|failed)$/, {
		timeout: CHAIN_TIMEOUT,
	});
	if ((await sync.getAttribute("data-state")) === "failed") {
		const row = (await sync.locator("xpath=..").textContent())?.trim();
		throw new Error(`Address sync failed: ${row}`);
	}
}

/** Spendable balance in satoshis, as wallet home shows it. */
export async function readBalanceSats(page: Page): Promise<number> {
	const balance = page.getByTestId("wallet-balance");
	await expect(balance).toHaveAttribute("data-sats", /^\d+$/, {
		timeout: CHAIN_TIMEOUT,
	});
	return Number(await balance.getAttribute("data-sats"));
}

/** The current deposit address from the Receive dialog on wallet home. */
export async function readDepositAddress(page: Page): Promise<string> {
	await page
		.getByRole("region", { name: "Spendable balance" })
		.getByRole("button", { name: "Receive", exact: true })
		.click();
	const dialog = page.getByRole("dialog", { name: "Receive BSV" });
	const address = dialog.getByRole("textbox", { name: "Deposit address" });
	await expect(address).not.toHaveValue("Unavailable");
	const value = await address.inputValue();
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	return value;
}
