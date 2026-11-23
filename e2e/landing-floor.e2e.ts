import { mkdir } from "node:fs/promises";
import { e2eTest } from "./support/e2e-test";
import { baseUrl, TESTNET_HOSTS } from "./support/env";
import { visitorInitScript } from "./support/init-script";
import {
	checkNoSidewaysScroll,
	describeViewport,
	LayoutProblems,
	PHONE_VIEWPORTS,
	setViewport,
	waitForSettledPage,
} from "./support/layout";

// The landing page for a first-time visitor on a phone: it says the live
// trading floor opens once a wallet is connected, offers that as the one
// primary action, and shows nothing of the floor (no bar, no peers, no
// count). A screenshot per phone size goes to e2e-artifacts/review/.

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
		await waitForSettledPage(browser, "/", '[data-testid="floor-note"]');
		for (const viewport of PHONE_VIEWPORTS) {
			const where = `/ at ${describeViewport(viewport)}`;
			await setViewport(browser, viewport);
			await checkNoSidewaysScroll(browser, where, problems);
			const page = await browser.evaluate(() => {
				const visible = (el: Element | null) =>
					Boolean(el && el.getClientRects().length > 0);
				const cta = Array.from(document.querySelectorAll("a")).find((a) =>
					/Connect wallet to enter/.test(a.textContent ?? ""),
				);
				const ctaBox = cta?.getBoundingClientRect();
				return {
					note: document.querySelector('[data-testid="floor-note"]')
						?.textContent,
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
			}, null);
			if (!page.note?.includes("opens when you connect a wallet")) {
				problems.add(`${where}: the floor note is missing (${page.note}).`);
			}
			if (page.ctaHeight < 44) {
				problems.add(
					`${where}: "Connect wallet to enter" is ${page.ctaHeight}px tall, expected 44px.`,
				);
			}
			if (page.ctaBottom > page.innerHeight) {
				problems.add(
					`${where}: "Connect wallet to enter" ends at ${page.ctaBottom}px, below the ${page.innerHeight}px window.`,
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
