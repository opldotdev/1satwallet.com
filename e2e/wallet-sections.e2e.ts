import type { Browser } from "./support/agent-browser";
import { e2eTest } from "./support/e2e-test";
import { baseUrl, TESTNET_HOSTS } from "./support/env";
import { visitorInitScript } from "./support/init-script";
import {
	checkNoSidewaysScroll,
	DESKTOP_VIEWPORT,
	describeViewport,
	LayoutProblems,
	MIN_TAP_TARGET,
	PHONE_VIEWPORTS,
	setViewport,
	TOLERANCE,
	type Viewport,
} from "./support/layout";
import { sectionLink } from "./support/wallet";

// Which wallet section you are in, as a first-time visitor on mainnet: the
// wallet chrome (headline and tabs) renders without a wallet, so this runs on
// every PR. The h1 is the current tab's label, exactly one tab is current and
// it is scrolled into view. Phones name every tab without icons; wider
// screens add the icons. Sub-pages show a back arrow and no tabs.

const SECTIONS = [
	{ path: "/wallet", label: "Wallet" },
	{ path: "/wallet/ordinals", label: "Ordinals" },
	{ path: "/wallet/opns", label: "OpNS" },
	{ path: "/wallet/identity", label: "Identity" },
	{ path: "/wallet/certificates", label: "Certificates" },
	{ path: "/wallet/bsv21", label: "BSV21" },
	{ path: "/wallet/history", label: "History" },
] as const;

const SUB_PAGES = [
	{
		path: "/wallet/settings",
		title: "Wallet settings",
		back: { label: "Back to Settings", href: "/settings" },
	},
	{
		path: "/wallet/create",
		title: "Create wallet",
		back: { label: "Back to Wallet", href: "/wallet" },
	},
	{
		path: "/wallet/import/json",
		title: "Import wallet",
		back: { label: "Back to Import wallet", href: "/wallet/import" },
	},
] as const;

const NAV = 'nav[aria-label="Wallet sections"]';

interface SectionChrome {
	pathname: string;
	h1: string[];
	nav: { left: number; right: number } | null;
	innerWidth: number;
	current: {
		text: string;
		left: number;
		right: number;
	}[];
	links: {
		name: string;
		width: number;
		height: number;
		/** The name is drawn, not only read out (it may sit past the edge). */
		labelShown: boolean;
		iconShown: boolean;
	}[];
}

function readSectionChrome(browser: Browser): Promise<SectionChrome> {
	return browser.evaluate((nav: string) => {
		const round = (n: number) => Math.round(n * 100) / 100;
		const clean = (text: string | null) =>
			(text ?? "").replace(/\s+/g, " ").trim();
		const shown = (el: Element | null) => {
			if (!el) return false;
			const rect = el.getBoundingClientRect();
			return rect.width > 1 && rect.height > 1;
		};
		const navEl = document.querySelector(nav);
		const navRect = navEl?.getBoundingClientRect();
		const links = Array.from(navEl?.querySelectorAll("a[href]") ?? []);
		return {
			pathname: location.pathname,
			h1: Array.from(document.querySelectorAll("h1"))
				.filter((el) => el.getClientRects().length > 0)
				.map((el) => clean(el.textContent)),
			nav: navRect
				? { left: round(navRect.left), right: round(navRect.right) }
				: null,
			innerWidth: window.innerWidth,
			current: links
				.filter((el) => el.getAttribute("aria-current") === "page")
				.map((el) => {
					const rect = el.getBoundingClientRect();
					return {
						text: clean(el.textContent),
						left: round(rect.left),
						right: round(rect.right),
					};
				}),
			links: links.map((el) => {
				const rect = el.getBoundingClientRect();
				return {
					name: clean(el.textContent),
					width: round(rect.width),
					height: round(rect.height),
					labelShown: shown(el.querySelector("span")),
					iconShown: shown(el.querySelector("svg")),
				};
			}),
		};
	}, NAV);
}

/** Waits for `pathname` with its headline and, on a section, its tab bar. */
async function waitForChrome(
	browser: Browser,
	pathname: string,
	title: string,
	withTabs: boolean,
) {
	await browser.waitFor(
		`${pathname} to show the headline "${title}"`,
		(args: {
			pathname: string;
			title: string;
			withTabs: boolean;
			nav: string;
		}) =>
			document.readyState === "complete" &&
			location.pathname === args.pathname &&
			Array.from(document.querySelectorAll("h1")).some(
				(el) => (el.textContent ?? "").trim() === args.title,
			) &&
			(!args.withTabs ||
				document.querySelector(`${args.nav} [aria-current="page"]`) !== null),
		{ pathname, title, withTabs, nav: NAV },
	);
}

/** The tab row's scroll state, for a failure message that shows its cause. */
function readTabRow(browser: Browser) {
	return browser.evaluate((nav: string) => {
		const round = (n: number) => Math.round(n * 100) / 100;
		const span = (el: Element) => {
			const rect = el.getBoundingClientRect();
			return `${round(rect.left)}-${round(rect.right)}px (${round(rect.width)}px wide)`;
		};
		const list = document.querySelector(`${nav} ul`);
		const current = document.querySelector(`${nav} [aria-current="page"]`);
		if (!list) return `no ${nav} ul`;
		return [
			`scrollLeft ${round(list.scrollLeft)}`,
			`clientWidth ${list.clientWidth}`,
			`scrollWidth ${list.scrollWidth}`,
			`list ${span(list)}`,
			current
				? `current tab "${(current.textContent ?? "").trim()}" ${span(current)}`
				: "no current tab",
		].join(", ");
	}, NAV);
}

/** Waits until the current tab has stopped scrolling into view. */
async function waitForCurrentTabInView(browser: Browser, where: string) {
	try {
		await browser.waitFor(
			`${where}: the current tab to scroll into view`,
			(nav: string) => {
				const list = document.querySelector(`${nav} ul`);
				const current = document.querySelector(`${nav} [aria-current="page"]`);
				if (!list || !current) return false;
				const box = list.getBoundingClientRect();
				const tab = current.getBoundingClientRect();
				return tab.left >= box.left - 1 && tab.right <= box.right + 1;
			},
			NAV,
		);
	} catch (error) {
		const row = await readTabRow(browser).catch(
			(readError: unknown) => `the row could not be read: ${readError}`,
		);
		throw new Error(`${(error as Error).message}. Tab row: ${row}.`, {
			cause: error,
		});
	}
}

function checkSection(
	chrome: SectionChrome,
	label: string,
	viewport: Viewport,
	where: string,
	problems: LayoutProblems,
) {
	if (chrome.h1.length !== 1 || chrome.h1[0] !== label) {
		problems.add(
			`${where}: visible h1 ${JSON.stringify(chrome.h1)}, expected exactly ["${label}"].`,
		);
	}
	if (!chrome.nav) {
		problems.add(`${where}: no ${NAV}, expected the section tabs.`);
		return;
	}
	if (chrome.current.length !== 1) {
		problems.add(
			`${where}: ${chrome.current.length} links with aria-current="page", expected 1.`,
		);
		return;
	}
	const [current] = chrome.current;
	if (current.text !== label) {
		problems.add(
			`${where}: the current tab is "${current.text}", expected "${label}" (the h1).`,
		);
	}
	const left = Math.max(chrome.nav.left, 0);
	const right = Math.min(chrome.nav.right, chrome.innerWidth);
	if (current.left < left - TOLERANCE || current.right > right + TOLERANCE) {
		problems.add(
			`${where}: the current tab spans ${current.left}-${current.right}px, expected it inside the visible tab bar ${left}-${right}px.`,
		);
	}
	const phone = viewport.width < 640;
	for (const link of chrome.links) {
		if (link.width < MIN_TAP_TARGET || link.height < MIN_TAP_TARGET) {
			problems.add(
				`${where}: tab "${link.name}" is ${link.width}x${link.height}px, expected at least ${MIN_TAP_TARGET}x${MIN_TAP_TARGET}px.`,
			);
		}
		// Every tab is named at every width; icons join the names from sm.
		if (!link.labelShown) {
			problems.add(
				`${where}: tab "${link.name}" shows no name, expected every tab named.`,
			);
		}
		if (link.iconShown === phone) {
			problems.add(
				`${where}: tab "${link.name}" icon is ${link.iconShown ? "shown" : "hidden"}, expected it ${phone ? "hidden on phones" : "shown from sm"}.`,
			);
		}
	}
}

const visitor = (path: string) => async () => {
	const origin = baseUrl().origin;
	return {
		url: new URL(path, origin).href,
		initScript: visitorInitScript(origin),
		secrets: [],
		forbiddenHosts: TESTNET_HOSTS,
	};
};

const VIEWPORTS: readonly Viewport[] = [...PHONE_VIEWPORTS, DESKTOP_VIEWPORT];

for (const section of SECTIONS) {
	e2eTest(
		`wallet sections: ${section.path} is headed "${section.label}" with its tab current`,
		visitor(section.path),
		async (browser) => {
			const problems = new LayoutProblems();
			for (const viewport of VIEWPORTS) {
				await setViewport(browser, viewport);
				const where = `${section.path} at ${describeViewport(viewport)}`;
				await waitForChrome(browser, section.path, section.label, true);
				await waitForCurrentTabInView(browser, where);
				checkSection(
					await readSectionChrome(browser),
					section.label,
					viewport,
					where,
					problems,
				);
				await checkNoSidewaysScroll(browser, where, problems);
			}
			problems.throwIfAny(`Wallet section ${section.path}`);
		},
	);
}

e2eTest(
	"wallet sections: tapping a tab on a phone moves the headline and brings the tab into view",
	visitor("/wallet"),
	async (browser) => {
		const problems = new LayoutProblems();
		const [viewport] = PHONE_VIEWPORTS;
		await setViewport(browser, viewport);
		await waitForChrome(browser, "/wallet", "Wallet", true);
		// History is last: on the narrowest phone it starts past the edge.
		for (const section of [SECTIONS[6], SECTIONS[4], SECTIONS[0]]) {
			await browser.click(sectionLink(section.label));
			const where = `${section.path} after a tap at ${describeViewport(viewport)}`;
			await waitForChrome(browser, section.path, section.label, true);
			await waitForCurrentTabInView(browser, where);
			checkSection(
				await readSectionChrome(browser),
				section.label,
				viewport,
				where,
				problems,
			);
		}
		problems.throwIfAny("Wallet tabs on a phone");
	},
);

for (const page of SUB_PAGES) {
	e2eTest(
		`wallet sections: ${page.path} is a sub-page with a back arrow and no tabs`,
		visitor(page.path),
		async (browser) => {
			const problems = new LayoutProblems();
			for (const viewport of [PHONE_VIEWPORTS[0], DESKTOP_VIEWPORT]) {
				await setViewport(browser, viewport);
				const where = `${page.path} at ${describeViewport(viewport)}`;
				await waitForChrome(browser, page.path, page.title, false);
				const found = await browser.evaluate(
					(args: { nav: string; label: string }) => {
						const back = document.querySelector(
							`a[aria-label="${args.label}"]`,
						);
						const rect = back?.getBoundingClientRect();
						return {
							tabs: document.querySelectorAll(args.nav).length,
							h1: Array.from(document.querySelectorAll("h1"))
								.filter((el) => el.getClientRects().length > 0)
								.map((el) => (el.textContent ?? "").trim()),
							back: back
								? {
										href: back.getAttribute("href"),
										width: Math.round((rect?.width ?? 0) * 100) / 100,
										height: Math.round((rect?.height ?? 0) * 100) / 100,
									}
								: null,
						};
					},
					{ nav: NAV, label: page.back.label },
				);
				if (found.tabs !== 0) {
					problems.add(
						`${where}: ${found.tabs} ${NAV} on the page, expected none on a sub-page.`,
					);
				}
				if (found.h1.length !== 1 || found.h1[0] !== page.title) {
					problems.add(
						`${where}: visible h1 ${JSON.stringify(found.h1)}, expected exactly ["${page.title}"].`,
					);
				}
				if (!found.back) {
					problems.add(
						`${where}: no link labelled "${page.back.label}", expected a back arrow.`,
					);
				} else {
					if (found.back.href !== page.back.href) {
						problems.add(
							`${where}: "${page.back.label}" goes to ${found.back.href}, expected ${page.back.href}.`,
						);
					}
					if (
						viewport.width < 768 &&
						(found.back.width < MIN_TAP_TARGET ||
							found.back.height < MIN_TAP_TARGET)
					) {
						problems.add(
							`${where}: "${page.back.label}" is ${found.back.width}x${found.back.height}px, expected at least ${MIN_TAP_TARGET}x${MIN_TAP_TARGET}px.`,
						);
					}
				}
				await checkNoSidewaysScroll(browser, where, problems);
			}
			problems.throwIfAny(`Wallet sub-page ${page.path}`);
		},
	);
}
