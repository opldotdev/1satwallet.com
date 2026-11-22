import { ACTION_TIMEOUT, type Browser } from "./support/agent-browser";
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
		"the Locks section",
		locks,
		undefined,
		undefined,
		CHAIN_TIMEOUT,
	);
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

/**
 * Nightly (E2E_REQUIRE_UNLOCK=1) the last run's one-block lock must be
 * unlocked. The one excuse is testnet mining no block since that run: its
 * lock is then still pending, at most MAX_PENDING_BLOCKS from unlocking.
 */
const MAX_PENDING_BLOCKS = 1;

/** Current height and the unlock block of each pending (not matured) lock. */
function readLockHeights(browser: Browser) {
	return browser.evaluate(() => {
		const section = document.querySelector(
			'section[aria-labelledby="wallet-locks-heading"]',
		);
		const number = (text: string | undefined) =>
			text ? Number(text.replaceAll(",", "")) : null;
		// Each figure is read from its own element: a row's textContent runs
		// "Unlock block 1,770,641" straight into "1 block left".
		const ownText = (el: Element) =>
			(el.textContent ?? "").replace(/\s+/g, " ").trim();
		const current = number(
			Array.from(
				section?.querySelectorAll('[data-slot="section-header"] p') ?? [],
				(p) => ownText(p).match(/· block ([\d,]+)$/)?.[1],
			).find(Boolean),
		);
		const pending = Array.from(section?.querySelectorAll("li") ?? [])
			.filter((li) => /blocks? left/.test(li.textContent ?? ""))
			.map((li) =>
				number(
					Array.from(
						li.querySelectorAll("p"),
						(p) => ownText(p).match(/^Unlock block ([\d,]+)$/)?.[1],
					).find(Boolean),
				),
			)
			.filter((until): until is number => until !== null);
		return { current, pending };
	}, null);
}

interface UnlockOutcome {
	unlocked: string | null;
	failed: string | null;
	/** An Unlock button still shows its spinner. */
	busy: boolean;
}

/**
 * What Locks shows of an unlock. With `pendingAsNull`, null until it ended
 * (for a wait). Runs in the page, so it is self-contained.
 */
function unlockOutcome(pendingAsNull: boolean): UnlockOutcome | null {
	const section = document.querySelector(
		'section[aria-labelledby="wallet-locks-heading"]',
	);
	const clean = (el: Element) =>
		(el.textContent ?? "").replace(/\s+/g, " ").trim();
	const unlocked =
		Array.from(section?.querySelectorAll('[role="status"]') ?? [], clean).find(
			(text) => /^Unlocked\. Transaction [0-9a-f]{64}$/.test(text),
		) ?? null;
	const failed =
		Array.from(section?.querySelectorAll('[role="alert"]') ?? [], clean).find(
			Boolean,
		) ?? null;
	const busy = Array.from(section?.querySelectorAll("button") ?? []).some(
		(button) =>
			/^Unlock( all \(\d+\))?$/.test(clean(button)) &&
			button.querySelector(".animate-spin") !== null,
	);
	if (pendingAsNull && unlocked === null && failed === null) return null;
	return { unlocked, failed, busy };
}

/**
 * Waits for the unlock to end: its "Unlocked. Transaction <txid>" status, or
 * the app's error in Locks, which fails the test at once with the app's own
 * words (the full reason is in the console, printed with the failure).
 */
async function waitForUnlockOutcome(browser: Browser) {
	try {
		await browser.waitFor(
			"the unlock to end (its transaction, or an error in Locks)",
			unlockOutcome,
			true,
			CHAIN_TIMEOUT,
		);
	} catch (error) {
		const now = await browser.evaluate(unlockOutcome, false);
		throw new Error(
			now?.busy
				? `The unlock is still running after ${CHAIN_TIMEOUT} ms: its button shows the spinner, and no transaction or error came.`
				: "The unlock ended with neither its transaction nor an error in Locks.",
			{ cause: error },
		);
	}
	const shown = await browser.evaluate(unlockOutcome, false);
	if (shown?.failed) throw new Error(`Unlocking failed: "${shown.failed}"`);
	if (!shown?.unlocked) {
		throw new Error("The unlock transaction went away before it was read.");
	}
}

// Runs first: locks from earlier runs whose block has passed are unlocked
// before this run adds its own one-block lock.
walletTest("unlocks matured locks from earlier runs", async (browser, t) => {
	await loadedLocks(browser);
	const { count } = await browser.query(maturedCoin);
	if (count === 0) {
		const { current, pending } = await readLockHeights(browser);
		const soonest = pending.length > 0 ? Math.min(...pending) : null;
		const waiting =
			current !== null &&
			soonest !== null &&
			soonest - current <= MAX_PENDING_BLOCKS;
		if (process.env.E2E_REQUIRE_UNLOCK === "1" && !waiting) {
			throw new Error(
				`No matured lock to unlock, and E2E_REQUIRE_UNLOCK=1. Current block ${current}; pending locks unlock at ${pending.join(", ") || "none"}. The last run's one-block lock should have matured or be at most ${MAX_PENDING_BLOCKS} block away.`,
			);
		}
		t.skip(
			waiting
				? `no matured lock yet; the newest unlocks at block ${soonest}, current ${current}`
				: "no matured lock; this run created one",
		);
		return;
	}

	const before = await readBalanceSats(browser);
	// The app offers "Unlock all (n)" once more than one coin is ready.
	await browser.click(
		count > 1
			? { role: "button", name: `Unlock all (${count})`, within: locks }
			: { role: "button", name: "Unlock", within: maturedCoin },
	);
	await waitForUnlockOutcome(browser);
	await browser.waitUntil(
		"the unlocked coins to leave the list",
		maturedCoin,
		(result) => result.count === 0,
		undefined,
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

	// The new coin shows once the locks list refreshes. Its row's own line
	// reads "Unlock block 1,770,641"; the row's whole text runs that straight
	// into "1 block left" or "Spendable", so the line is matched, not the row.
	const coinDescription = `the coin unlocking at block ${until}`;
	const coin: Locator = {
		role: "listitem",
		within: locks,
		has: {
			role: "any",
			text: pattern(new RegExp(`^Unlock block ${until}$`)),
		},
	};
	// The list refreshes itself after a lock; Refresh is only clicked after a
	// wait comes up empty, and only once it is enabled again.
	const deadline = Date.now() + CHAIN_TIMEOUT;
	let refreshes = 0;
	for (;;) {
		try {
			// One agent-browser wait per round.
			await browser.waitUntil(
				coinDescription,
				coin,
				undefined,
				undefined,
				ACTION_TIMEOUT,
			);
			return;
		} catch (error) {
			const notYet =
				error instanceof Error && error.message.startsWith("Timed out");
			if (!notYet) throw error;
			if (Date.now() >= deadline) {
				throw new Error(
					`Timed out after ${CHAIN_TIMEOUT} ms: ${coinDescription} (Refresh locks clicked ${refreshes} times)`,
					{ cause: error },
				);
			}
			await browser.click(
				{ role: "button", name: "Refresh locks", within: locks },
				CHAIN_TIMEOUT,
			);
			refreshes++;
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
