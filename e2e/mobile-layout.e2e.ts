import { e2eTest } from "./support/e2e-test";
import { baseUrl, TESTNET_HOSTS } from "./support/env";
import { visitorInitScript } from "./support/init-script";
import {
	CLOSE_CHECK_VIEWPORTS,
	checkCloseControlCorner,
	checkDesktopDensity,
	checkNoSidewaysScroll,
	checkTapTargets,
	checkViewportFitCover,
	DESKTOP_VIEWPORT,
	describeViewport,
	LayoutProblems,
	PHONE_VIEWPORTS,
	setViewport,
	waitForOpenDialog,
	waitForSettledPage,
} from "./support/layout";

// The phone layout as a first-time visitor: no wallet, no secrets. Each page
// must fit the phone's width, draw under the notch (viewport-fit=cover) and
// give every button, input and select trigger a 44px tap target. On desktop
// the density stays as it was: 36px default buttons, no monospace h1.
// The wallet's own pages are in mobile-layout-wallet.e2e.ts (testnet suite).

interface VisitorRoute {
	path: string;
	/** On the page once it has rendered its content. */
	ready: string;
	/** The page has a default-size button, so the desktop check measures one. */
	hasDefaultButton: boolean;
}

const ROUTES: readonly VisitorRoute[] = [
	{
		path: "/",
		ready: '[aria-label="Choose a wallet"]',
		hasDefaultButton: false,
	},
	{
		path: "/wallet",
		ready: '[aria-label="Choose a wallet"]',
		hasDefaultButton: false,
	},
	{
		path: "/wallet/create",
		ready: 'input[aria-label="Mnemonic word 12"]',
		hasDefaultButton: true,
	},
	{
		path: "/wallet/import",
		ready: 'a[href="/wallet/import/json"]',
		hasDefaultButton: false,
	},
	{
		path: "/wallet/import/json",
		ready: 'input[aria-label="Wallet backup file"]',
		hasDefaultButton: false,
	},
	{
		path: "/wallet/import/mnemonic",
		ready: 'input[aria-label="Mnemonic word 12"]',
		hasDefaultButton: true,
	},
];

for (const route of ROUTES) {
	e2eTest(
		`mobile layout of ${route.path} for a new visitor`,
		async () => {
			const origin = baseUrl().origin;
			return {
				url: new URL(route.path, origin).href,
				initScript: visitorInitScript(origin),
				secrets: [],
				forbiddenHosts: TESTNET_HOSTS,
			};
		},
		async (browser) => {
			const problems = new LayoutProblems();
			await waitForSettledPage(browser, route.path, route.ready);
			await checkViewportFitCover(browser, route.path, problems);

			for (const viewport of PHONE_VIEWPORTS) {
				await setViewport(browser, viewport);
				await waitForSettledPage(browser, route.path, route.ready);
				const where = `${route.path} at ${describeViewport(viewport)}`;
				await checkNoSidewaysScroll(browser, where, problems);
				await checkTapTargets(browser, where, problems);
			}

			await setViewport(browser, DESKTOP_VIEWPORT);
			await waitForSettledPage(browser, route.path, route.ready);
			const where = `${route.path} at ${describeViewport(DESKTOP_VIEWPORT)}`;
			const measured = await checkDesktopDensity(browser, where, problems);
			if (route.hasDefaultButton && measured === 0) {
				problems.add(
					`${where}: measured 0 default-size buttons (classes h-9 px-4 py-2), expected at least 1.`,
				);
			}

			problems.throwIfAny(`Mobile layout of ${route.path}`);
		},
	);
}

// The command palette (Ctrl+K, on every page) is the one dialog a visitor can
// open without a wallet or a peer, so it carries the close control check on
// every PR. It does not scroll itself (its list does), so only the resting
// corner is measured here; the wallet spec's Send dialog covers scrolling.
const COMMAND_PALETTE = "Command Palette";

e2eTest(
	"mobile layout: the dialog close control sits in the top-right corner",
	async () => {
		const origin = baseUrl().origin;
		return {
			url: new URL("/", origin).href,
			initScript: visitorInitScript(origin),
			secrets: [],
			forbiddenHosts: TESTNET_HOSTS,
		};
	},
	async (browser) => {
		const problems = new LayoutProblems();
		await waitForSettledPage(browser, "/", "h1");
		for (const viewport of CLOSE_CHECK_VIEWPORTS) {
			await setViewport(browser, viewport);
			await waitForSettledPage(browser, "/", "h1");
			await browser.press("Control+k");
			await waitForOpenDialog(browser, COMMAND_PALETTE);
			await checkCloseControlCorner(
				browser,
				`Command palette at ${describeViewport(viewport)}`,
				problems,
			);
			await browser.press("Escape");
			await browser.waitUntil(
				"the command palette to close",
				{ role: "dialog", name: COMMAND_PALETTE },
				(result) => result.count === 0,
			);
		}
		problems.throwIfAny("Dialog close control");
	},
);
