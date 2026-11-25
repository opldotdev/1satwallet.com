import { mkdir } from "node:fs/promises";
import { e2eTest } from "./support/e2e-test";
import { baseUrl, TESTNET_HOSTS } from "./support/env";
import { DOM_MISSES_KEY, visitorInitScript } from "./support/init-script";
import {
	checkNoSidewaysScroll,
	describeViewport,
	LayoutProblems,
	PHONE_VIEWPORTS,
	setViewport,
	waitForSettledPage,
} from "./support/layout";

// The landing page for a first-time visitor on a phone: it shows the wallet
// chooser, whose leading slide on this (non-Apple) browser offers Create
// wallet inside the window, and shows nothing of the floor (no bar, no peers,
// no count). A screenshot per phone size goes to e2e-artifacts/review/.

const CREATE_WALLET =
	'section[aria-label="Choose a wallet"] a[href="/wallet/create"]';

const REVIEW_DIR = "e2e-artifacts/review";

e2eTest(
	"landing floor stays closed for a visitor without a wallet",
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
		await mkdir(REVIEW_DIR, { recursive: true });
		await waitForSettledPage(browser, "/", CREATE_WALLET);
		for (const viewport of PHONE_VIEWPORTS) {
			const where = `/ at ${describeViewport(viewport)}`;
			await setViewport(browser, viewport);
			await checkNoSidewaysScroll(browser, where, problems);
			const page = await browser.evaluate((selector) => {
				const visible = (el: Element | null) =>
					Boolean(el && el.getClientRects().length > 0);
				const cta = document.querySelector(selector);
				const ctaBox = cta?.getBoundingClientRect();
				return {
					ctaText: cta?.textContent?.trim() ?? "",
					note: document.querySelector('[data-testid="floor-note"]') !== null,
					headline: visible(document.querySelector("h1")),
					ctaHeight: ctaBox?.height ?? 0,
					ctaBottom: ctaBox?.bottom ?? Number.POSITIVE_INFINITY,
					innerHeight: window.innerHeight,
					floorBar: visible(
						document.querySelector('[data-testid="floor-bar"]'),
					),
					// Rendered text only: inline scripts must not count.
					// biome-ignore lint/performance/useDomNodeTextContent: visible text is the point.
					online: /\bonline\b|peers? here/i.test(document.body.innerText),
				};
			}, CREATE_WALLET);
			if (page.ctaText !== "Create wallet") {
				problems.add(
					`${where}: the chooser's create button reads "${page.ctaText}", expected "Create wallet".`,
				);
			}
			if (page.note) {
				problems.add(`${where}: the old floor note still shows.`);
			}
			if (!page.headline) {
				problems.add(`${where}: the headline isn't visible.`);
			}
			if (page.ctaHeight < 44) {
				problems.add(
					`${where}: "Create wallet" is ${page.ctaHeight}px tall, expected 44px.`,
				);
			}
			if (page.ctaBottom > page.innerHeight) {
				problems.add(
					`${where}: "Create wallet" ends at ${page.ctaBottom}px, below the ${page.innerHeight}px window.`,
				);
			}
			if (page.floorBar || page.online) {
				problems.add(
					`${where}: the floor shows to a visitor without a wallet.`,
				);
			}
			await browser.screenshot(
				`${REVIEW_DIR}/landing-signed-out-${viewport.width}x${viewport.height}.png`,
			);
		}
		problems.throwIfAny("Landing page for a new visitor");
	},
);

// A fresh load of the landing page on a desktop window, where the 3D logo
// renders, must not throw. React's "removeChild" error shows up as a removal
// of a node that isn't a child of its parent, which the init script records.
e2eTest(
	"landing page loads without a DOM error for a visitor on desktop",
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
		await waitForSettledPage(browser, "/", CREATE_WALLET);
		// The logo is done once its 3D scene has mounted (canvas shown, loading
		// spinner gone), or the 3D failed and its boundary shows the static
		// logo instead, or a removal already failed.
		await browser.waitFor(
			"the hero logo to finish loading",
			(key) => {
				const logo = document.querySelector('[data-testid="hero-logo"]');
				const misses = (window as unknown as Record<string, unknown[]>)[key];
				return (
					misses.length > 0 ||
					(Boolean(logo?.querySelector("canvas")) &&
						!logo?.querySelector('[data-testid="hero-logo-loading"]')) ||
					Boolean(logo?.querySelector('[data-testid="hero-logo-fallback"]'))
				);
			},
			DOM_MISSES_KEY,
		);
		const misses = await browser.evaluate(
			(key) => (window as unknown as Record<string, unknown[]>)[key],
			DOM_MISSES_KEY,
		);
		if (misses.length > 0) {
			throw new Error(
				`The landing page removed ${misses.length} node(s) that weren't children of their parent:\n${JSON.stringify(misses, null, 2)}`,
			);
		}
	},
);
