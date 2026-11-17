import type { Browser } from "./support/agent-browser";
import { baseUrl } from "./support/env";
import {
	CLOSE_CHECK_VIEWPORTS,
	checkBottomSheet,
	checkCenteredDialog,
	checkCloseControlCorner,
	checkNoSidewaysScroll,
	DESKTOP_VIEWPORT,
	describeViewport,
	LayoutProblems,
	measureOpenDialog,
	PHONE_VIEWPORTS,
	setViewport,
	type Viewport,
	waitForOpenDialog,
	waitForSettledPage,
} from "./support/layout";
import type { Locator } from "./support/page-query";
import {
	CHAIN_TIMEOUT,
	sectionLink,
	unlockWallet,
	walletTest,
} from "./support/wallet";

// The phone layout of the wallet's own pages, as testnet wallet A. Read-only:
// dialogs are opened and closed, nothing is signed or broadcast.
// The visitor pages are in mobile-layout.e2e.ts (mainnet suite).

/**
 * /wallet/opns is mainnet-only: on testnet the app serves its "not on
 * testnet" notice at that URL, and that notice must fit the phone too.
 */
const WALLET_ROUTES = [
	"/wallet",
	"/wallet/ordinals",
	"/wallet/tokens",
	"/wallet/opns",
	"/wallet/identity",
	"/wallet/certificates",
	"/wallet/history",
	"/wallet/settings",
] as const;

walletTest(
	"mobile layout: wallet pages do not scroll sideways",
	async (browser) => {
		const problems = new LayoutProblems();
		const origin = baseUrl().origin;
		for (const path of WALLET_ROUTES) {
			await setViewport(browser, PHONE_VIEWPORTS[0]);
			// walletTest starts on /wallet, unlocked. A page load locks the wallet,
			// so every other page is opened and unlocked again.
			if (path !== "/wallet") {
				await browser.open(new URL(path, origin).href);
				await unlockWallet(browser);
			}
			await waitForSettledPage(browser, path, null, CHAIN_TIMEOUT);
			for (const viewport of PHONE_VIEWPORTS) {
				await setViewport(browser, viewport);
				await waitForSettledPage(browser, path, null, CHAIN_TIMEOUT);
				await checkNoSidewaysScroll(
					browser,
					`${path} at ${describeViewport(viewport)}`,
					problems,
				);
			}
		}
		problems.throwIfAny("Wallet pages on phones");
	},
);

const sendButton: Locator = {
	role: "button",
	name: "Send",
	within: { role: "region", name: "Spendable balance" },
};
/** A dialog locator; its name is the title waited on. */
type DialogLocator = Locator & { name: string };

const sendDialog: DialogLocator = { role: "dialog", name: "Send BSV" };

const bannerPickerButton: Locator = {
	role: "button",
	name: "Pick from my ordinals",
	// Avatar comes first, then Banner.
	index: 1,
};
const bannerPicker: DialogLocator = { role: "dialog", name: "Choose a banner" };

/**
 * Opens a dialog at `viewport`, measures it, runs `whileOpen` (if any) and
 * closes it again.
 */
async function measureDialogAt(
	browser: Browser,
	viewport: Viewport,
	trigger: Locator,
	dialog: DialogLocator,
	whileOpen?: () => Promise<unknown>,
) {
	await setViewport(browser, viewport);
	await browser.click(trigger);
	await waitForOpenDialog(browser, dialog.name);
	const geometry = await measureOpenDialog(browser);
	await whileOpen?.();
	await browser.press("Escape");
	await browser.waitUntil(
		`the "${dialog.name}" dialog to close`,
		dialog,
		(result) => result.count === 0,
	);
	return geometry;
}

walletTest(
	"mobile layout: dialogs are bottom sheets on phones and centered on desktop",
	async (browser) => {
		const problems = new LayoutProblems();
		// The close control stays in the top-right corner, at rest and with
		// the content scrolled to the bottom.
		const closeCheckAt = (viewport: Viewport) =>
			CLOSE_CHECK_VIEWPORTS.some(
				(v) => v.width === viewport.width && v.height === viewport.height,
			)
				? () =>
						checkCloseControlCorner(
							browser,
							`Send dialog at ${describeViewport(viewport)}`,
							problems,
						)
				: undefined;

		for (const viewport of PHONE_VIEWPORTS) {
			const geometry = await measureDialogAt(
				browser,
				viewport,
				sendButton,
				sendDialog,
				closeCheckAt(viewport),
			);
			// Its footer (Review payment) is checked for full-width buttons.
			checkBottomSheet(
				geometry,
				`Send dialog at ${describeViewport(viewport)}`,
				problems,
			);
		}
		const desktop = await measureDialogAt(
			browser,
			DESKTOP_VIEWPORT,
			sendButton,
			sendDialog,
			closeCheckAt(DESKTOP_VIEWPORT),
		);
		checkCenteredDialog(
			desktop,
			`Send dialog at ${describeViewport(DESKTOP_VIEWPORT)}`,
			problems,
		);

		// The banner picker has a DialogFooter (Cancel), so the full-width
		// footer button check measures a real button. Client-side navigation
		// keeps the wallet unlocked.
		await browser.click(sectionLink("Identity"));
		await waitForSettledPage(browser, "/wallet/identity", null, CHAIN_TIMEOUT);
		await browser.waitUntil(
			"the profile form",
			{ role: "textbox", name: "Public bio" },
			undefined,
			undefined,
			CHAIN_TIMEOUT,
		);
		await browser.waitUntil(
			"the banner picker button",
			bannerPickerButton,
			undefined,
			undefined,
			CHAIN_TIMEOUT,
		);
		for (const viewport of PHONE_VIEWPORTS) {
			const where = `Banner picker at ${describeViewport(viewport)}`;
			const geometry = await measureDialogAt(
				browser,
				viewport,
				bannerPickerButton,
				bannerPicker,
			);
			const footerButtons = checkBottomSheet(geometry, where, problems);
			if (geometry.count === 1 && footerButtons === 0) {
				problems.add(
					`${where}: measured 0 buttons in [data-slot="dialog-footer"], expected at least 1 (Cancel).`,
				);
			}
		}

		problems.throwIfAny("Wallet dialogs");
	},
);
