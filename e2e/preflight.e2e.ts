import { expect, test } from "./fixtures/wallet";
import { TESTNET_FAUCET_URL } from "./support/env";
import {
	readBalanceSats,
	readDepositAddress,
	TESTNET_BADGE_LABEL,
} from "./support/waits";

/** Enough for many runs of the spending projects at a few thousand sats each. */
const MINIMUM_SATS = 50_000;

test("wallet A is a funded testnet account", async ({ page }) => {
	await expect(
		page.getByLabel(TESTNET_BADGE_LABEL).filter({ visible: true }).first(),
	).toBeVisible();

	const address = await readDepositAddress(page);
	expect(address, "testnet deposit address").toMatch(/^[mn]/);

	const balance = await readBalanceSats(page);
	if (balance < MINIMUM_SATS) {
		throw new Error(
			`Top up the e2e test wallet: send testnet BSV to ${address} (${TESTNET_FAUCET_URL}). Balance: ${balance.toLocaleString("en-US")} sats, need ${MINIMUM_SATS.toLocaleString("en-US")}.`,
		);
	}
});
