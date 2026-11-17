import type { Browser } from "./support/agent-browser";
import { e2eTest } from "./support/e2e-test";
import { baseUrl, TESTNET_HOSTS } from "./support/env";
import { visitorInitScript } from "./support/init-script";
import {
	checkNoSidewaysScroll,
	checkTapTargets,
	DESKTOP_VIEWPORT,
	describeViewport,
	LayoutProblems,
	PHONE_VIEWPORTS,
	setViewport,
	TOLERANCE,
	type Viewport,
	waitForSettledPage,
} from "./support/layout";

// Onboarding on a phone, as a first-time visitor. The create flow is walked
// from the seed phrase to its check and stops there: no word is read, typed
// or kept, and the throwaway phrase the page generated is cleared from the
// screen before any failure screenshot. Nothing is saved.

const PHONE = PHONE_VIEWPORTS[0];

const visitor = (path: string) => async () => {
	const origin = baseUrl().origin;
	return {
		url: new URL(path, origin).href,
		initScript: visitorInitScript(origin),
		secrets: [],
		forbiddenHosts: TESTNET_HOSTS,
		beforeScreenshot: clearSeedWords,
	};
};

/** Blanks every seed word field, so a screenshot shows no phrase. */
async function clearSeedWords(browser: Browser) {
	await browser.evaluate(() => {
		for (const input of Array.from(
			document.querySelectorAll<HTMLInputElement>(
				'input[aria-label^="Mnemonic word "]',
			),
		)) {
			input.value = "";
		}
	}, null);
}

interface ActionWidth {
	/** The button's width. */
	width: number;
	/** The width of the card content box it sits in. */
	available: number;
}

/** Measures the visible button named `name` against its card's content box. */
function measureAction(browser: Browser, name: string) {
	return browser.evaluate((label: string): ActionWidth | null => {
		const button = Array.from(
			document.querySelectorAll<HTMLElement>('[data-slot="button"]'),
		).find(
			(el) =>
				el.getClientRects().length > 0 &&
				(el.textContent ?? "").replace(/\s+/g, " ").trim() === label,
		);
		// The card part the button sits in: the step's action footer (a
		// CardFooter whose data-slot OnboardingStep renames to
		// "onboarding-actions"), another footer, or the content. Its padding is
		// read resolved, in px: --card-spacing itself is a calc() string.
		const part = button?.closest<HTMLElement>(
			'[data-slot="onboarding-actions"], [data-slot="card-footer"], [data-slot="card-content"]',
		);
		if (!button || !part?.closest('[data-slot="card"]')) return null;
		const style = getComputedStyle(part);
		return {
			width: button.getBoundingClientRect().width,
			available:
				part.clientWidth -
				Number.parseFloat(style.paddingLeft) -
				Number.parseFloat(style.paddingRight),
		};
	}, name);
}

/** On a phone the step's primary button spans its card. */
async function checkFullWidthAction(
	browser: Browser,
	name: string,
	where: string,
	problems: LayoutProblems,
) {
	const measured = await measureAction(browser, name);
	if (!measured) {
		problems.add(`${where}: found no visible "${name}" button inside a card.`);
		return;
	}
	if (Math.abs(measured.width - measured.available) > TOLERANCE) {
		problems.add(
			`${where}: "${name}" is ${Math.round(measured.width)}px wide, expected the card's full ${Math.round(measured.available)}px.`,
		);
	}
}

/** From desktop widths the same button keeps its own width. */
async function checkInlineAction(
	browser: Browser,
	name: string,
	where: string,
	problems: LayoutProblems,
) {
	const measured = await measureAction(browser, name);
	if (!measured) {
		problems.add(`${where}: found no visible "${name}" button inside a card.`);
		return;
	}
	if (measured.width >= measured.available - TOLERANCE) {
		problems.add(
			`${where}: "${name}" spans the card (${Math.round(measured.width)}px), expected its own width on desktop.`,
		);
	}
}

async function checkPhoneStep(
	browser: Browser,
	path: string,
	ready: string,
	primary: string | null,
	problems: LayoutProblems,
	viewports: readonly Viewport[] = PHONE_VIEWPORTS,
) {
	for (const viewport of viewports) {
		await setViewport(browser, viewport);
		await waitForSettledPage(browser, path, ready);
		const where = `${path} at ${describeViewport(viewport)}`;
		await checkNoSidewaysScroll(browser, where, problems);
		await checkTapTargets(browser, where, problems);
		if (primary) await checkFullWidthAction(browser, primary, where, problems);
	}
}

e2eTest(
	"onboarding layout: the create flow at 375px has full-width primaries and no sideways scroll",
	visitor("/wallet/create"),
	async (browser) => {
		const problems = new LayoutProblems();
		const seedReady = 'input[aria-label="Mnemonic word 12"]';
		await setViewport(browser, PHONE);
		await waitForSettledPage(browser, "/wallet/create", seedReady);
		const stepLabel = await browser.query({
			role: "any",
			text: { source: "^Step 1 of 3$", flags: "" },
		});
		if (stepLabel.count === 0) {
			problems.add('/wallet/create: found no "Step 1 of 3" label.');
		}
		await checkPhoneStep(
			browser,
			"/wallet/create",
			seedReady,
			"I have saved my seed phrase",
			problems,
		);

		await setViewport(browser, DESKTOP_VIEWPORT);
		await waitForSettledPage(browser, "/wallet/create", seedReady);
		await checkInlineAction(
			browser,
			"I have saved my seed phrase",
			`/wallet/create at ${describeViewport(DESKTOP_VIEWPORT)}`,
			problems,
		);

		// On to the check, which asks for three words. None is filled in.
		await setViewport(browser, PHONE);
		await waitForSettledPage(browser, "/wallet/create", seedReady);
		await browser.click({
			role: "button",
			name: "I have saved my seed phrase",
		});
		await waitForSettledPage(
			browser,
			"/wallet/create/confirm",
			'input[aria-label^="Mnemonic word "]',
		);
		await checkPhoneStep(
			browser,
			"/wallet/create/confirm",
			'input[aria-label^="Mnemonic word "]',
			"Confirm & Continue",
			problems,
		);
		// The check's fields take the width beside their labels.
		await setViewport(browser, PHONE);
		const narrowest = await browser.evaluate(
			() =>
				Math.min(
					...Array.from(
						document.querySelectorAll<HTMLInputElement>(
							'input[aria-label^="Mnemonic word "]',
						),
						(input) => input.getBoundingClientRect().width,
					),
				),
			null,
		);
		if (!(narrowest >= 180)) {
			problems.add(
				`/wallet/create/confirm at ${describeViewport(PHONE)}: the narrowest word field is ${Math.round(narrowest)}px, expected at least 180px.`,
			);
		}
		await clearSeedWords(browser);
		problems.throwIfAny("Create flow on a phone");
	},
);

e2eTest(
	"onboarding layout: the import pages fit a phone",
	visitor("/wallet/import"),
	async (browser) => {
		const problems = new LayoutProblems();
		await checkPhoneStep(
			browser,
			"/wallet/import",
			'a[href="/wallet/import/json"]',
			null,
			problems,
		);
		// Each source is one tap target, at least 44px tall.
		const heights = await browser.evaluate(
			() =>
				Array.from(
					document.querySelectorAll<HTMLAnchorElement>(
						'a[href^="/wallet/import/"]',
					),
					(link) => link.getBoundingClientRect().height,
				),
			null,
		);
		if (heights.length !== 2 || heights.some((height) => height < 44)) {
			problems.add(
				`/wallet/import: source links are ${heights.map(Math.round).join(", ")}px tall, expected 2 links of at least 44px.`,
			);
		}

		const origin = baseUrl().origin;
		await browser.open(new URL("/wallet/import/mnemonic", origin).href);
		await checkPhoneStep(
			browser,
			"/wallet/import/mnemonic",
			'input[aria-label="Mnemonic word 12"]',
			"Next",
			problems,
		);

		await browser.open(new URL("/wallet/import/json", origin).href);
		await checkPhoneStep(
			browser,
			"/wallet/import/json",
			'input[aria-label="Wallet backup file"]',
			null,
			problems,
		);
		problems.throwIfAny("Import pages on a phone");
	},
);

e2eTest(
	"onboarding layout: settings are icon rows that fit a phone",
	visitor("/settings"),
	async (browser) => {
		const problems = new LayoutProblems();
		await checkPhoneStep(
			browser,
			"/settings",
			'[data-slot="settings-row"]',
			null,
			problems,
		);
		const rows = await browser.evaluate(
			() =>
				Array.from(
					document.querySelectorAll<HTMLElement>('[data-slot="settings-row"]'),
					(row) => row.querySelectorAll("svg.size-5").length,
				),
			null,
		);
		if (rows.length === 0) problems.add("/settings: found no settings rows.");
		for (const [index, icons] of rows.entries()) {
			if (icons < 1) {
				problems.add(`/settings: row ${index + 1} has no 20px icon.`);
			}
		}
		problems.throwIfAny("Settings on a phone");
	},
);
