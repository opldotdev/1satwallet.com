import type { Browser } from "./support/agent-browser";
import { baseUrl } from "./support/env";
import {
	checkNoSidewaysScroll,
	checkTapTargets,
	describeViewport,
	LayoutProblems,
	MIN_TAP_TARGET,
	PHONE_VIEWPORTS,
	setViewport,
	TOLERANCE,
	waitForSettledPage,
} from "./support/layout";
import type { Locator } from "./support/page-query";
import { CHAIN_TIMEOUT, unlockWallet, walletTest } from "./support/wallet";

// The phone layout of the wallet's lists (batch D4), as testnet wallet A.
// Read-only: ordinals are selected and cleared, nothing is signed or sent.

/** A history row is two lines: what and how much; when, txid and status. */
const MAX_HISTORY_ROW = 72;

/** Opens `path` in a fresh page load and unlocks the wallet again. */
async function openWalletPage(
	browser: Browser,
	path: string,
	ready: string,
): Promise<void> {
	await setViewport(browser, PHONE_VIEWPORTS[0]);
	await browser.open(new URL(path, baseUrl().origin).href);
	await unlockWallet(browser);
	await waitForSettledPage(browser, path, ready, CHAIN_TIMEOUT);
}

/** History has loaded: rows, or its empty state. */
const HISTORY_READY =
	'[data-slot="history-row"], section[aria-label="Transaction history"] [data-slot="empty-state"]';

walletTest(
	"mobile lists: history rows are two lines, at most 72px tall",
	async (browser) => {
		const problems = new LayoutProblems();
		await openWalletPage(browser, "/wallet/history", HISTORY_READY);

		for (const viewport of PHONE_VIEWPORTS) {
			const where = `/wallet/history at ${describeViewport(viewport)}`;
			await setViewport(browser, viewport);
			await waitForSettledPage(
				browser,
				"/wallet/history",
				HISTORY_READY,
				CHAIN_TIMEOUT,
			);
			const rows = await browser.evaluate(
				() =>
					Array.from(
						document.querySelectorAll('[data-slot="history-row"]'),
						(row) => ({
							text: (row.textContent ?? "")
								.replace(/\s+/g, " ")
								.trim()
								.slice(0, 60),
							height: Math.round(row.getBoundingClientRect().height * 10) / 10,
						}),
					),
				null,
			);
			if (rows.length === 0) {
				problems.add(
					`${where}: found no [data-slot="history-row"], expected wallet A's transactions to measure.`,
				);
			}
			for (const row of rows) {
				if (row.height > MAX_HISTORY_ROW + TOLERANCE) {
					problems.add(
						`${where}: history row "${row.text}" is ${row.height}px tall, expected at most ${MAX_HISTORY_ROW}px.`,
					);
				}
			}
			await checkNoSidewaysScroll(browser, where, problems);
			await checkTapTargets(browser, where, problems);
		}
		problems.throwIfAny("History on phones");
	},
);

const selectionBar: Locator = { role: "region", name: "Selected ordinals" };

interface BarGeometry {
	count: number;
	left: number;
	right: number;
	top: number;
	bottom: number;
	innerWidth: number;
	innerHeight: number;
	buttons: { label: string; height: number }[];
}

function measureSelectionBar(browser: Browser): Promise<BarGeometry> {
	return browser.evaluate(() => {
		const round = (n: number) => Math.round(n * 100) / 100;
		const bars = Array.from(
			document.querySelectorAll('[data-slot="selection-bar"]'),
		).filter((el) => el.getClientRects().length > 0);
		const rect = bars[0]?.getBoundingClientRect();
		const buttons = bars[0]
			? Array.from(bars[0].querySelectorAll('[data-slot="button"]'), (el) => ({
					label:
						el.getAttribute("aria-label") ??
						(el.textContent ?? "").replace(/\s+/g, " ").trim(),
					height: round(el.getBoundingClientRect().height),
				}))
			: [];
		return {
			count: bars.length,
			left: round(rect?.left ?? Number.NaN),
			right: round(rect?.right ?? Number.NaN),
			top: round(rect?.top ?? Number.NaN),
			bottom: round(rect?.bottom ?? Number.NaN),
			innerWidth: window.innerWidth,
			innerHeight: window.innerHeight,
			buttons,
		};
	}, null);
}

/** Index, among the visible checkboxes, of the first one that is enabled. */
const firstSelectableOrdinal = (browser: Browser) =>
	browser.evaluate(
		() =>
			Array.from(
				document.querySelectorAll('input[type="checkbox"],[role="checkbox"]'),
			)
				.filter(
					(el) =>
						el.getClientRects().length > 0 &&
						getComputedStyle(el).visibility !== "hidden",
				)
				.findIndex(
					(el) =>
						!!el.closest('[data-slot="ordinal-tile"]') &&
						!(el as HTMLInputElement).disabled,
				),
		null,
	);

walletTest(
	"mobile lists: the ordinals action bar shows only with a selection",
	async (browser, t) => {
		const problems = new LayoutProblems();
		await openWalletPage(
			browser,
			"/wallet/ordinals",
			'[data-slot="ordinal-tile"], [data-slot="empty-state"]',
		);

		for (const viewport of PHONE_VIEWPORTS) {
			const where = `/wallet/ordinals at ${describeViewport(viewport)}`;
			await setViewport(browser, viewport);
			await waitForSettledPage(
				browser,
				"/wallet/ordinals",
				'[data-slot="ordinal-tile"], [data-slot="empty-state"]',
				CHAIN_TIMEOUT,
			);
			const idle = await browser.query(selectionBar);
			if (idle.count !== 0) {
				problems.add(
					`${where}: the "Selected ordinals" bar shows with nothing selected, expected it hidden.`,
				);
			}
			await checkNoSidewaysScroll(browser, where, problems);
			await checkTapTargets(browser, where, problems);

			const index = await firstSelectableOrdinal(browser);
			if (index < 0) {
				t.diagnostic(
					`${where}: wallet A has no selectable ordinal, so the bar with a selection was not measured.`,
				);
				continue;
			}
			const checkbox: Locator = { role: "checkbox", index };
			await browser.click(checkbox);
			await browser.waitUntil("the selection bar to show", selectionBar);
			const bar = await measureSelectionBar(browser);
			const near = (actual: number, expected: number) =>
				Math.abs(actual - expected) <= TOLERANCE;
			if (bar.count !== 1) {
				problems.add(
					`${where}: ${bar.count} selection bars with one ordinal selected, expected 1.`,
				);
			} else {
				if (!near(bar.left, 0) || !near(bar.right, bar.innerWidth)) {
					problems.add(
						`${where}: selection bar spans ${bar.left}-${bar.right}px, expected edge to edge (0-${bar.innerWidth}px).`,
					);
				}
				if (bar.top < 0 || bar.bottom > bar.innerHeight + TOLERANCE) {
					problems.add(
						`${where}: selection bar is at ${bar.top}-${bar.bottom}px, expected it inside the ${bar.innerHeight}px window.`,
					);
				}
				if (bar.buttons.length < 2) {
					problems.add(
						`${where}: selection bar has ${bar.buttons.length} buttons (${bar.buttons.map((b) => b.label).join(", ")}), expected Clear selection and at least one action.`,
					);
				}
				for (const button of bar.buttons) {
					if (button.height < MIN_TAP_TARGET) {
						problems.add(
							`${where}: selection bar button "${button.label}" is ${button.height}px tall, expected at least ${MIN_TAP_TARGET}px.`,
						);
					}
				}
			}
			await checkNoSidewaysScroll(browser, `${where}, one selected`, problems);

			await browser.click({
				role: "button",
				name: "Clear selection",
				within: selectionBar,
			});
			await browser.waitUntil(
				"the selection bar to hide",
				selectionBar,
				(result) => result.count === 0,
			);
		}
		problems.throwIfAny("Ordinals on phones");
	},
);
