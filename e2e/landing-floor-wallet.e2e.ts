import { mkdir } from "node:fs/promises";
import {
	checkNoSidewaysScroll,
	describeViewport,
	LayoutProblems,
	PHONE_VIEWPORTS,
	setViewport,
} from "./support/layout";
import { walletTest } from "./support/wallet";

// The landing page as testnet wallet A, signed in: the primary action opens
// the wallet and the floor bar shows (live, or joining while the wallet
// signs). CI builds against a placeholder relay, so there the bar shows
// joining and then that the floor isn't responding; a preview or production
// build shows it live. A screenshot
// per phone size goes to e2e-artifacts/review/.

const REVIEW_DIR = "e2e-artifacts/review";

walletTest("landing floor opens for a signed-in wallet", async (browser) => {
	const problems = new LayoutProblems();
	await mkdir(REVIEW_DIR, { recursive: true });
	// Client-side navigation keeps the unlocked wallet.
	await browser.evaluate(() => {
		(
			window as unknown as {
				next: { router: { push: (href: string) => void } };
			}
		).next.router.push("/");
	}, null);
	await browser.waitFor(
		"the floor bar on the landing page",
		() =>
			location.pathname === "/" &&
			document.querySelector('[data-testid="floor-bar"]') !== null,
		null,
	);
	for (const viewport of PHONE_VIEWPORTS) {
		const where = `/ at ${describeViewport(viewport)} with a wallet`;
		await setViewport(browser, viewport);
		await checkNoSidewaysScroll(browser, where, problems);
		const page = await browser.evaluate(() => {
			const bar = document.querySelector('[data-testid="floor-bar"]');
			const box = bar?.firstElementChild?.getBoundingClientRect();
			return {
				note: document.querySelector('[data-testid="floor-note"]') !== null,
				openWallet: Array.from(document.querySelectorAll("a")).some((a) =>
					/Open wallet/.test(a.textContent ?? ""),
				),
				barText: bar?.textContent ?? "",
				barBottom: box?.bottom ?? 0,
				innerHeight: window.innerHeight,
			};
		}, null);
		if (page.note) {
			problems.add(`${where}: the signed-out floor note still shows.`);
		}
		if (!page.openWallet) {
			problems.add(`${where}: no "Open wallet" action.`);
		}
		// CI's placeholder relay never answers, so there the bar ends on its
		// "isn't responding" error with Try again.
		if (
			!/Live floor|Joining the floor|Couldn't join the floor/.test(page.barText)
		) {
			problems.add(`${where}: the floor bar reads "${page.barText}".`);
		}
		if (page.barBottom > page.innerHeight) {
			problems.add(
				`${where}: the floor bar ends at ${page.barBottom}px, below the window.`,
			);
		}
		await browser.screenshot(
			`${REVIEW_DIR}/landing-signed-in-${viewport.width}x${viewport.height}.png`,
		);
	}
	problems.throwIfAny("Landing page with a wallet");
});
