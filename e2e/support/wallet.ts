import type { TestContext } from "node:test";
import type { Browser } from "./agent-browser";
import { e2eTest } from "./e2e-test";
import { baseUrl, MAINNET_ONLY_HOSTS, testWalletA } from "./env";
import { walletInitScript } from "./init-script";
import type { Locator } from "./page-query";

/** For waits that follow a broadcast or a sync. */
export const CHAIN_TIMEOUT = 60_000;

export const TESTNET_BADGE_LABEL = "Testnet account. Coins have no real value.";

const unlockDialog: Locator = { role: "dialog", name: "Unlock wallet" };

/** The tab of a wallet section: a link in the "Wallet sections" navigation. */
export const sectionLink = (name: string): Locator => ({
	role: "link",
	name,
	within: { role: "navigation", name: "Wallet sections" },
});

/** Clears the passphrase field and drops the passphrase from the page. */
function clearPassphrase(browser: Browser) {
	return browser.evaluate(() => {
		const input = document.querySelector("#passphrase");
		if (input instanceof HTMLInputElement && input.value) {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set?.call(input, "");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}
		const forget = (window as { __e2eForgetPassphrase?: () => void })
			.__e2eForgetPassphrase;
		forget?.();
		return true;
	}, null);
}

/**
 * Unlocks with wallet A's passphrase. The init script types it; the command
 * line only ever carries the name of the function that does.
 */
export async function unlockWallet(browser: Browser) {
	await browser.waitUntil(
		"the unlock screen",
		unlockDialog,
		undefined,
		undefined,
		CHAIN_TIMEOUT,
	);
	const entered = await browser.evaluate(
		() =>
			(
				window as { __e2eEnterPassphrase?: () => boolean }
			).__e2eEnterPassphrase?.() === true,
		null,
	);
	if (!entered) {
		throw new Error(
			"Could not enter the passphrase: no passphrase field on the unlock screen, or the init script did not run.",
		);
	}
	await browser.click({ role: "button", name: "Unlock", within: unlockDialog });
	try {
		await browser.waitUntil(
			"the unlock screen to close",
			unlockDialog,
			(result) => result.count === 0,
			undefined,
			CHAIN_TIMEOUT,
		);
	} catch (error) {
		// Clear the field before the failure screenshot.
		const cleared = await clearPassphrase(browser).then(
			() => null,
			(clearError: unknown) => clearError,
		);
		const shown = await browser.query(unlockDialog);
		throw new Error(
			`The wallet did not unlock. Unlock screen: "${shown.text ?? ""}"`,
			{ cause: cleared ? new AggregateError([error, cleared]) : error },
		);
	}
	await clearPassphrase(browser);
}

const walletBalance = (browser: Browser) =>
	browser.evaluate(
		() =>
			document
				.querySelector('[data-testid="wallet-balance"]')
				?.getAttribute("data-sats") ?? null,
		null,
	);

/** Wallet home is usable: balance rendered and the first address sync done. */
export async function waitForWalletReady(browser: Browser) {
	await browser.waitFor(
		"the wallet balance",
		() =>
			/^\d+$/.test(
				document
					.querySelector('[data-testid="wallet-balance"]')
					?.getAttribute("data-sats") ?? "",
			),
		null,
		CHAIN_TIMEOUT,
	);
	const selector = '[data-testid="wallet-sync-state"][data-task="addresses"]';
	await browser.waitFor(
		"the first address sync to finish",
		(css: string) =>
			["succeeded", "failed"].includes(
				document.querySelector(css)?.getAttribute("data-state") ?? "",
			),
		selector,
		CHAIN_TIMEOUT,
	);
	const failed = await browser.evaluate((css: string) => {
		const sync = document.querySelector(css);
		return sync?.getAttribute("data-state") === "failed"
			? (sync.parentElement?.textContent ?? "").trim()
			: null;
	}, selector);
	if (failed !== null) throw new Error(`Address sync failed: ${failed}`);
}

/** Spendable balance in satoshis, as wallet home shows it. */
export async function readBalanceSats(browser: Browser): Promise<number> {
	const sats = await walletBalance(browser);
	if (sats === null || !/^\d+$/.test(sats)) {
		throw new Error(
			`Wallet home shows no balance in satoshis (data-sats: ${sats}). Is privacy mode on?`,
		);
	}
	return Number(sats);
}

/** Waits until wallet home shows more than `sats`. */
export async function waitForBalanceAbove(browser: Browser, sats: number) {
	await browser.waitFor(
		`the balance to rise above ${sats} sats`,
		(min: number) =>
			Number(
				document
					.querySelector('[data-testid="wallet-balance"]')
					?.getAttribute("data-sats") ?? "-1",
			) > min,
		sats,
		CHAIN_TIMEOUT,
	);
}

/** The current deposit address from the Receive dialog on wallet home. */
export async function readDepositAddress(browser: Browser): Promise<string> {
	await browser.click({
		role: "button",
		name: "Receive",
		within: { role: "region", name: "Spendable balance" },
	});
	const dialog: Locator = { role: "dialog", name: "Receive BSV" };
	const address: Locator = {
		role: "textbox",
		name: "Deposit address",
		within: dialog,
	};
	await browser.waitUntil(
		"a deposit address",
		address,
		(result) => Boolean(result.value) && result.value !== "Unavailable",
		undefined,
		CHAIN_TIMEOUT,
	);
	const { value } = await browser.query(address);
	await browser.press("Escape");
	await browser.waitUntil(
		"the Receive dialog to close",
		dialog,
		(result) => result.count === 0,
	);
	if (!value) throw new Error("The Receive dialog lost its deposit address.");
	return value;
}

/**
 * A test that starts on wallet home, unlocked, as testnet wallet A in its own
 * agent-browser session. Fails if the app requests a mainnet-only host.
 */
export function walletTest(
	name: string,
	body: (browser: Browser, t: TestContext) => Promise<void>,
) {
	e2eTest(
		name,
		async () => {
			const wallet = await testWalletA();
			const origin = baseUrl().origin;
			return {
				url: new URL("/wallet", origin).href,
				initScript: walletInitScript(origin, wallet),
				secrets: [wallet.passphrase, wallet.backup],
				forbiddenHosts: MAINNET_ONLY_HOSTS,
				beforeScreenshot: async (browser) => {
					await clearPassphrase(browser);
				},
			};
		},
		async (browser, t) => {
			await unlockWallet(browser);
			await waitForWalletReady(browser);
			await body(browser, t);
		},
	);
}
