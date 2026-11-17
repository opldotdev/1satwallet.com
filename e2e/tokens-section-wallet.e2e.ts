import type { Browser } from "./support/agent-browser";
import {
	checkNoSidewaysScroll,
	checkTapTargets,
	describeViewport,
	LayoutProblems,
	PHONE_VIEWPORTS,
	setViewport,
	waitForOpenDialog,
	waitForSettledPage,
} from "./support/layout";
import type { Locator } from "./support/page-query";
import { CHAIN_TIMEOUT, sectionLink, walletTest } from "./support/wallet";

// The Tokens section as testnet wallet A: BSV-21 and 1Color in one section,
// a Create token sheet that asks which standard and keeps what was typed
// across a switch, and token rows that open the wallet's own token page,
// never the market. Read-only: the sheet is closed before any review.

const NAV = 'nav[aria-label="Wallet sections"]';
const createDialog: Locator = { role: "dialog", name: "Create token" };
const inSheet = (locator: Locator): Locator => ({
	...locator,
	within: createDialog,
});
const symbolField = inSheet({ role: "textbox", name: "Symbol" });
const SYMBOL = "KEEPME";

/** The visible h1s and the current tabs. */
function readHeadings(browser: Browser) {
	return browser.evaluate((nav: string) => {
		const clean = (text: string | null) =>
			(text ?? "").replace(/\s+/g, " ").trim();
		return {
			h1: Array.from(document.querySelectorAll("h1"))
				.filter((el) => el.getClientRects().length > 0)
				.map((el) => clean(el.textContent)),
			current: Array.from(
				document.querySelectorAll(`${nav} [aria-current="page"]`),
			).map((el) => clean(el.textContent)),
		};
	}, NAV);
}

/** The standard picker in the open sheet: each radio's name and state. */
function readPicker(browser: Browser) {
	return browser.evaluate(() => {
		const dialog = document.querySelector(
			'[data-slot="dialog-content"][data-state="open"]',
		);
		return Array.from(
			dialog?.querySelectorAll('[role="radiogroup"] [role="radio"]') ?? [],
		).map((el) => ({
			name: (el.textContent ?? "").trim(),
			checked: el.getAttribute("aria-checked") === "true",
		}));
	}, null);
}

/** Every token row's href, by group. */
function readRows(browser: Browser) {
	return browser.evaluate(() => {
		const hrefs = (group: string) =>
			Array.from(
				document.querySelectorAll(
					`section[aria-labelledby="${group}"] a[data-slot="token-row"]`,
				),
			).map((el) => el.getAttribute("href") ?? "");
		return {
			bsv21: hrefs("tokens-bsv21"),
			oneColor: hrefs("tokens-1color"),
			market: Array.from(
				document.querySelectorAll('a[data-slot="token-row"]'),
			).filter((el) => (el.getAttribute("href") ?? "").startsWith("/market"))
				.length,
		};
	}, null);
}

async function checkPhones(
	browser: Browser,
	pathname: string,
	problems: LayoutProblems,
) {
	for (const viewport of PHONE_VIEWPORTS) {
		await setViewport(browser, viewport);
		await waitForSettledPage(browser, pathname, null, CHAIN_TIMEOUT);
		const where = `${pathname} at ${describeViewport(viewport)}`;
		await checkNoSidewaysScroll(browser, where, problems);
		await checkTapTargets(browser, where, problems);
	}
}

walletTest(
	"tokens: testnet lists BSV-21 and 1Color, asks the standard and opens tokens in the wallet",
	async (browser, t) => {
		const problems = new LayoutProblems();
		// A tab tap keeps the wallet unlocked; a page load would lock it.
		await setViewport(browser, PHONE_VIEWPORTS[0]);
		await browser.click(sectionLink("Tokens"));
		await waitForSettledPage(browser, "/wallet/tokens", null, CHAIN_TIMEOUT);
		const headings = await readHeadings(browser);
		if (headings.h1.length !== 1 || headings.h1[0] !== "Tokens") {
			problems.add(
				`/wallet/tokens: visible h1 ${JSON.stringify(headings.h1)}, expected exactly ["Tokens"].`,
			);
		}
		if (headings.current.length !== 1 || headings.current[0] !== "Tokens") {
			problems.add(
				`/wallet/tokens: current tabs ${JSON.stringify(headings.current)}, expected exactly ["Tokens"].`,
			);
		}
		await checkPhones(browser, "/wallet/tokens", problems);

		// The sheet asks BSV-21 or 1Color, and a switch keeps the symbol.
		await setViewport(browser, PHONE_VIEWPORTS[0]);
		await browser.click({ role: "button", name: "Create token" });
		await waitForOpenDialog(browser, "Create token");
		const picker = await readPicker(browser);
		const names = picker.map((radio) => radio.name);
		if (JSON.stringify(names) !== JSON.stringify(["BSV-21", "1Color"])) {
			problems.add(
				`Create token: standard picker ${JSON.stringify(names)}, expected ["BSV-21","1Color"].`,
			);
		}
		if (!picker[0]?.checked) {
			problems.add("Create token: BSV-21 is not picked when the sheet opens.");
		}
		await browser.fill(symbolField, SYMBOL);
		for (const standard of ["1Color", "BSV-21"]) {
			await browser.click(inSheet({ role: "button", name: standard }));
			await browser.waitUntil(
				`${standard} to be picked`,
				inSheet({
					role: "button",
					name: standard,
					attributes: ["aria-checked"],
				}),
				(result) => result.attributes["aria-checked"] === "true",
			);
			const field = await browser.query(symbolField);
			if (field.value !== SYMBOL) {
				problems.add(
					`Create token: after switching to ${standard} the symbol is ${JSON.stringify(field.value)}, expected "${SYMBOL}".`,
				);
			}
		}
		await checkNoSidewaysScroll(
			browser,
			`Create token sheet at ${describeViewport(PHONE_VIEWPORTS[0])}`,
			problems,
		);
		await browser.press("Escape");
		await browser.waitUntil(
			"the Create token sheet to close",
			createDialog,
			(result) => result.count === 0,
		);

		// Rows open the wallet's own token page, never the market.
		const rows = await readRows(browser);
		if (rows.market > 0) {
			problems.add(
				`/wallet/tokens: ${rows.market} token rows link to /market.`,
			);
		}
		for (const href of rows.bsv21) {
			if (!href.startsWith("/wallet/bsv21/")) {
				problems.add(`/wallet/tokens: a BSV-21 row links to ${href}.`);
			}
		}
		for (const href of rows.oneColor) {
			if (!href.startsWith("/wallet/1color/")) {
				problems.add(`/wallet/tokens: a 1Color row links to ${href}.`);
			}
		}
		problems.throwIfAny("Tokens on testnet");

		const [first] = rows.bsv21;
		if (!first) {
			t.skip("wallet A holds no BSV-21 token, so there is no row to open.");
			return;
		}
		await browser.click({
			role: "link",
			within: { role: "region", name: "BSV-21" },
			index: 0,
		});
		await waitForSettledPage(browser, first, null, CHAIN_TIMEOUT);
		const detail = await readHeadings(browser);
		if (detail.h1.length !== 1 || detail.h1[0] !== "BSV-21 token") {
			problems.add(
				`${first}: visible h1 ${JSON.stringify(detail.h1)}, expected exactly ["BSV-21 token"].`,
			);
		}
		await browser.waitFor(
			"the token's balance",
			() => document.querySelector('[data-testid="token-balance"]') !== null,
			null,
			CHAIN_TIMEOUT,
		);
		await checkPhones(browser, first, problems);
		problems.throwIfAny("BSV-21 token page on testnet");
	},
);
