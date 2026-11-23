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

/**
 * What wallet home shows, for a failure message: the unlock screen, or the
 * start of the page's text (a loading status, "Wallet data could not be
 * refreshed", "Wallet could not be opened" and the like). A field's value is
 * not part of the text read, so no passphrase can reach it.
 */
function describeWalletHome(browser: Browser): Promise<string> {
	return browser.evaluate(() => {
		const clean = (text: string | null | undefined) =>
			(text ?? "").replace(/\s+/g, " ").trim();
		if (document.querySelector('[role="dialog"][aria-label="Unlock wallet"]')) {
			return "the unlock screen";
		}
		const busy = Array.from(document.querySelectorAll('[role="status"]'))
			.map((el) => clean(el.textContent))
			.filter(Boolean);
		const main = document.querySelector("main");
		const text = main ? clean(main.textContent) : "(no <main> on the page)";
		return `${text.slice(0, 300) || "(an empty page)"}${busy.length ? `; status: ${busy.join(" | ").slice(0, 200)}` : ""}`;
	}, null);
}

/**
 * Wallet home is usable: balance rendered and the first sync of both address
 * kinds done: the legacy deposit addresses ("addresses") and the built-in
 * wallet's own BRC-29 Receive addresses ("receive-addresses"), where a fresh
 * deposit to the shown address lands.
 */
export async function waitForWalletReady(browser: Browser) {
	try {
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
	} catch (error) {
		// Name what wallet home shows instead: still loading, the balance
		// error, a wallet that could not be opened, or the lock screen.
		const shown = await describeWalletHome(browser).catch(
			(readError: unknown) =>
				`(could not be read: ${readError instanceof Error ? readError.message : String(readError)})`,
		);
		throw new Error(`Wallet home shows no balance. It shows: ${shown}`, {
			cause: error,
		});
	}
	for (const task of ["addresses", "receive-addresses"]) {
		const selector = `[data-testid="wallet-sync-state"][data-task="${task}"]`;
		await browser.waitFor(
			`the first ${task} sync to finish`,
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
		if (failed !== null) throw new Error(`${task} sync failed: ${failed}`);
	}
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
				secrets: [wallet.passphrase, wallet.backup, ...wallet.keySecrets],
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
