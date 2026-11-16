import { e2eTest } from "./support/e2e-test";
import { baseUrl, TESTNET_HOSTS } from "./support/env";
import { visitorInitScript } from "./support/init-script";
import {
	checkDesktopDensity,
	checkNoSidewaysScroll,
	checkTapTargets,
	checkViewportFitCover,
	DESKTOP_VIEWPORT,
	describeViewport,
	LayoutProblems,
	PHONE_VIEWPORTS,
	setViewport,
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
	{ path: "/", ready: "h1", hasDefaultButton: false },
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
