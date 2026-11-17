import type { Browser } from "./support/agent-browser";
import { e2eTest } from "./support/e2e-test";
import { baseUrl, TESTNET_HOSTS } from "./support/env";
import { visitorInitScript } from "./support/init-script";
import {
	checkNoSidewaysScroll,
	describeViewport,
	LayoutProblems,
	PHONE_VIEWPORTS,
	setViewport,
	waitForOpenDialog,
} from "./support/layout";
import type { Locator } from "./support/page-query";

// The Tokens section on mainnet, as a first-time visitor: one h1, Tokens
// the current tab, no 1Color anywhere and a Create token sheet with no
// standard picker (BSV-21 is the only standard). The old BSV21 and 1Color
// addresses land on Tokens. Read-only: nothing is signed.

const NAV = 'nav[aria-label="Wallet sections"]';
const createButton: Locator = { role: "button", name: "Create token" };
const createDialog: Locator = { role: "dialog", name: "Create token" };

const visitor = (path: string) => async () => {
	const origin = baseUrl().origin;
	return {
		url: new URL(path, origin).href,
		initScript: visitorInitScript(origin),
		secrets: [],
		forbiddenHosts: TESTNET_HOSTS,
	};
};

/** The visible h1s, the current tabs and whether "1Color" shows anywhere. */
function readTokensPage(browser: Browser) {
	return browser.evaluate((nav: string) => {
		const clean = (text: string | null) =>
			(text ?? "").replace(/\s+/g, " ").trim();
		return {
			pathname: location.pathname,
			h1: Array.from(document.querySelectorAll("h1"))
				.filter((el) => el.getClientRects().length > 0)
				.map((el) => clean(el.textContent)),
			current: Array.from(
				document.querySelectorAll(`${nav} [aria-current="page"]`),
			).map((el) => clean(el.textContent)),
			oneColor: /1\s*Color/i.test(
				document.querySelector("main")?.textContent ?? "",
			),
		};
	}, NAV);
}

async function waitForTokens(browser: Browser) {
	await browser.waitFor(
		'/wallet/tokens to show the headline "Tokens" and its tab',
		(nav: string) =>
			document.readyState === "complete" &&
			location.pathname === "/wallet/tokens" &&
			Array.from(document.querySelectorAll("h1")).some(
				(el) => (el.textContent ?? "").trim() === "Tokens",
			) &&
			document.querySelector(`${nav} [aria-current="page"]`) !== null,
		NAV,
	);
}

e2eTest(
	"tokens: mainnet shows BSV-21 only, one h1 and Tokens as the current tab",
	visitor("/wallet/tokens"),
	async (browser) => {
		const problems = new LayoutProblems();
		for (const viewport of PHONE_VIEWPORTS) {
			await setViewport(browser, viewport);
			const where = `/wallet/tokens at ${describeViewport(viewport)}`;
			await waitForTokens(browser);
			const page = await readTokensPage(browser);
			if (page.h1.length !== 1 || page.h1[0] !== "Tokens") {
				problems.add(
					`${where}: visible h1 ${JSON.stringify(page.h1)}, expected exactly ["Tokens"].`,
				);
			}
			if (page.current.length !== 1 || page.current[0] !== "Tokens") {
				problems.add(
					`${where}: current tabs ${JSON.stringify(page.current)}, expected exactly ["Tokens"].`,
				);
			}
			if (page.oneColor) {
				problems.add(
					`${where}: the page mentions 1Color, a testnet-only standard.`,
				);
			}
			await checkNoSidewaysScroll(browser, where, problems);
		}

		const [phone] = PHONE_VIEWPORTS;
		await setViewport(browser, phone);
		await browser.click(createButton);
		await waitForOpenDialog(browser, "Create token");
		const sheet = await browser.evaluate(() => {
			const dialog = document.querySelector(
				'[data-slot="dialog-content"][data-state="open"]',
			);
			return {
				pickers: dialog?.querySelectorAll('[role="radiogroup"]').length ?? -1,
				radios: dialog?.querySelectorAll('[role="radio"]').length ?? -1,
				oneColor: /1\s*Color/i.test(dialog?.textContent ?? ""),
				symbol: dialog?.querySelector("#create-token-symbol") !== null,
			};
		}, null);
		const where = `Create token sheet at ${describeViewport(phone)}`;
		if (sheet.pickers !== 0 || sheet.radios !== 0) {
			problems.add(
				`${where}: ${sheet.pickers} radiogroups and ${sheet.radios} radios, expected no standard picker on mainnet.`,
			);
		}
		if (sheet.oneColor) {
			problems.add(`${where}: the sheet mentions 1Color on mainnet.`);
		}
		if (!sheet.symbol) {
			problems.add(`${where}: no Symbol field, expected the BSV-21 form.`);
		}
		await checkNoSidewaysScroll(browser, where, problems);
		await browser.press("Escape");
		await browser.waitUntil(
			"the Create token sheet to close",
			createDialog,
			(result) => result.count === 0,
		);
		problems.throwIfAny("Tokens on mainnet");
	},
);

for (const path of ["/wallet/bsv21", "/wallet/1color"]) {
	e2eTest(
		`tokens: ${path} lands on the Tokens section`,
		visitor(path),
		async (browser) => {
			await waitForTokens(browser);
			const page = await readTokensPage(browser);
			if (page.h1.length !== 1 || page.h1[0] !== "Tokens") {
				throw new Error(
					`${path} landed on ${page.pathname} with visible h1 ${JSON.stringify(page.h1)}, expected exactly ["Tokens"].`,
				);
			}
		},
	);
}
