import type { Browser } from "./support/agent-browser";
import { type Locator, pattern } from "./support/page-query";
import {
	CHAIN_TIMEOUT,
	readBalanceSats,
	waitForBalanceAbove,
	walletTest,
} from "./support/wallet";

const locks: Locator = { role: "region", name: "Locks" };
const lockDialog: Locator = { role: "dialog", name: "Lock BSV" };

/** A coin row with a usable Unlock button. */
const maturedCoin: Locator = {
	role: "listitem",
	within: locks,
	has: { role: "button", name: "Unlock" },
	notText: pattern(/no wallet tracking record/),
};

async function loadedLocks(browser: Browser) {
	await browser.waitUntil(
		"the Locks section to load",
		{ role: "any", text: pattern(/Loading locks…/), within: locks },
		(result) => result.count === 0,
		undefined,
		CHAIN_TIMEOUT,
	);
	const failed = await browser.query({
		role: "any",
		text: pattern(/Locks could not be loaded\. Try again\./),
		within: locks,
	});
	if (failed.count > 0) throw new Error("Locks could not be loaded.");
}

/** Opens "Lock BSV" with an amount entered. */
async function openLockDialog(browser: Browser, amount: string) {
	await browser.click({ role: "button", name: "Lock BSV", within: locks });
	await browser.fill(
		{ role: "textbox", name: "Amount (BSV)", within: lockDialog },
		amount,
	);
}

async function alertText(browser: Browser, dialog: Locator) {
	const alert: Locator = { role: "alert", within: dialog };
	await browser.waitUntil(
		"an error message",
		alert,
		(result) => Boolean(result.text),
		undefined,
		CHAIN_TIMEOUT,
	);
	return (await browser.query(alert)).text;
}

// Runs first: a lock from an earlier run whose block has passed is unlocked
// before this run adds its own one-block lock.
walletTest("unlocks a matured lock from an earlier run", async (browser, t) => {
	await loadedLocks(browser);
	const { count } = await browser.query(maturedCoin);
	if (count === 0) {
		if (process.env.E2E_REQUIRE_UNLOCK === "1") {
			throw new Error(
				"No matured lock to unlock, and E2E_REQUIRE_UNLOCK=1. The previous runs' one-block locks should have matured by now.",
			);
		}
		t.skip("no matured lock; this run created one");
		return;
	}

	const before = await readBalanceSats(browser);
	await browser.click({
		role: "button",
		name: "Unlock",
		within: { ...maturedCoin, index: 0 },
	});
	await browser.waitUntil(
		"the unlock transaction",
		{
			role: "any",
			text: pattern(/^Unlocked\. Transaction [0-9a-f]{64}$/),
			within: locks,
		},
		undefined,
		undefined,
		CHAIN_TIMEOUT,
	);
	await browser.waitUntil(
		"the unlocked coin to leave the list",
		maturedCoin,
		(result, expected) => result.count === expected,
		count - 1,
		CHAIN_TIMEOUT,
	);
	await waitForBalanceAbove(browser, before);
});

walletTest("locks 0.00001 BSV for one block", async (browser) => {
	await loadedLocks(browser);
	await openLockDialog(browser, "0.00001");
	await browser.click({
		role: "button",
		name: "After blocks",
		within: lockDialog,
	});
	await browser.fill(
		{ role: "textbox", name: "Blocks from now", within: lockDialog },
		"1",
	);
	await browser.click({
		role: "button",
		name: "Review lock",
		within: lockDialog,
	});

	await browser.waitUntil(
		"the lock review",
		{ role: "any", text: pattern(/Unlocks at block/), within: lockDialog },
		undefined,
		undefined,
		CHAIN_TIMEOUT,
	);
	const amount = await browser.query({
		role: "any",
		text: pattern(/0\.00001000 BSV/),
		within: lockDialog,
	});
	if (amount.count === 0) {
		throw new Error("The lock review does not show 0.00001000 BSV.");
	}
	await browser.click({
		role: "button",
		name: "Confirm and lock",
		within: lockDialog,
	});

	const locked: Locator = { role: "dialog", name: "BSV locked" };
	const description: Locator = {
		role: "any",
		text: pattern(/^It unlocks at block [\d,]+\.$/),
		within: locked,
	};
	await browser.waitUntil(
		"the BSV locked dialog",
		description,
		undefined,
		undefined,
		CHAIN_TIMEOUT,
	);
	const { text } = await browser.query(description);
	const until = text?.match(/block ([\d,]+)\./)?.[1];
	if (!until) {
		throw new Error(`No unlock block in the success dialog: "${text}"`);
	}
	await browser.click({ role: "button", name: "Done", within: locked });

	// The new coin shows once the locks list refreshes.
	const coin: Locator = {
		role: "listitem",
		within: locks,
		text: pattern(new RegExp(`Unlock block ${until}\\b`)),
	};
	const deadline = Date.now() + CHAIN_TIMEOUT;
	for (;;) {
		await browser.click({
			role: "button",
			name: "Refresh locks",
			within: locks,
		});
		try {
			await browser.waitUntil(
				`the coin unlocking at block ${until}`,
				coin,
				undefined,
				undefined,
				0,
			);
			return;
		} catch (error) {
			if (Date.now() >= deadline) throw error;
		}
	}
});

walletTest(
	"rejects a zero amount and a block that is not after the current height",
	async (browser) => {
		await loadedLocks(browser);

		await openLockDialog(browser, "0");
		await browser.click({
			role: "button",
			name: "Review lock",
			within: lockDialog,
		});
		const zero = await alertText(browser, lockDialog);
		if (zero !== "Enter a positive BSV amount with no more than 8 decimals.") {
			throw new Error(`Unexpected error for a zero amount: "${zero}"`);
		}
		await browser.press("Escape");
		await browser.waitUntil(
			"the Lock BSV dialog to close",
			lockDialog,
			(result) => result.count === 0,
		);

		await openLockDialog(browser, "0.00001");
		await browser.click({
			role: "button",
			name: "At block height",
			within: lockDialog,
		});
		await browser.fill(
			{ role: "textbox", name: "Unlock block height", within: lockDialog },
			"1",
		);
		await browser.click({
			role: "button",
			name: "Review lock",
			within: lockDialog,
		});
		const past = await alertText(browser, lockDialog);
		if (!/^Pick a block after the current height, [\d,]+\.$/.test(past ?? "")) {
			throw new Error(`Unexpected error for a past block: "${past}"`);
		}
	},
);
