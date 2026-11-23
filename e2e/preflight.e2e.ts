import assert from "node:assert/strict";
import { TESTNET_FAUCET_URL } from "./support/env";
import {
	readBalanceSats,
	readDepositAddress,
	TESTNET_BADGE_LABEL,
	waitForBalanceAbove,
	walletTest,
} from "./support/wallet";

/** Enough for many runs of the spending tests at a few thousand sats each. */
const MINIMUM_SATS = 50_000;

walletTest("wallet A is a funded testnet account", async (browser) => {
	await browser.waitFor(
		"the Testnet badge",
		(label: string) =>
			Array.from(document.querySelectorAll(`[aria-label="${label}"]`)).some(
				(el) => el.getClientRects().length > 0,
			),
		TESTNET_BADGE_LABEL,
	);

	const address = await readDepositAddress(browser);
	assert.match(address, /^[mn]/, "testnet deposit address");

	// A deposit synced just now can reach the balance a moment after the sync.
	try {
		await waitForBalanceAbove(browser, MINIMUM_SATS - 1);
	} catch (error) {
		if (!(error instanceof Error && error.message.startsWith("Timed out")))
			throw error;
	}
	const balance = await readBalanceSats(browser);
	if (balance < MINIMUM_SATS) {
		throw new Error(
			`Top up the e2e test wallet: send testnet BSV to ${address} (${TESTNET_FAUCET_URL}). Balance: ${balance.toLocaleString("en-US")} sats, need ${MINIMUM_SATS.toLocaleString("en-US")}.`,
		);
	}
});
