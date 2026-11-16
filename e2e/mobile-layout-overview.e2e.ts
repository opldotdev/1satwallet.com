import type { Browser } from "./support/agent-browser";
import { baseUrl } from "./support/env";
import {
	checkBottomSheet,
	checkNoSidewaysScroll,
	DESKTOP_VIEWPORT,
	describeViewport,
	LayoutProblems,
	MIN_TAP_TARGET,
	measureOpenDialog,
	PHONE_VIEWPORTS,
	setViewport,
	TOLERANCE,
	type Viewport,
	waitForOpenDialog,
	waitForSettledPage,
} from "./support/layout";
import type { Locator } from "./support/page-query";
import {
	CHAIN_TIMEOUT,
	readDepositAddress,
	unlockWallet,
	walletTest,
} from "./support/wallet";

// The wallet overview, its Receive, Send and Lock BSV sheets and the unlock
// screen on phones, as testnet wallet A. Read-only: sheets are opened and
// closed, nothing is signed or broadcast.

/** The smallest balance figure on a phone (the plan asks 34px; 32 is the floor). */
const MIN_BALANCE_FONT = 32;

const balanceRegion: Locator = { role: "region", name: "Spendable balance" };
const locksRegion: Locator = { role: "region", name: "Locks" };

interface OverviewGeometry {
	innerWidth: number;
	balance: { fontSize: number; right: number } | null;
	radarShown: boolean;
	/** Visible buttons in the balance and Locks sections. */
	buttons: { label: string; width: number; height: number }[];
}

function measureOverview(browser: Browser): Promise<OverviewGeometry> {
	return browser.evaluate(() => {
		const round = (n: number) => Math.round(n * 10) / 10;
		const balance = document.querySelector('[data-testid="wallet-balance"]');
		const rect = balance?.getBoundingClientRect();
		const hero = document.querySelector(
			'section[aria-labelledby="wallet-balance-heading"]',
		);
		const locks = document.querySelector(
			'section[aria-labelledby="wallet-locks-heading"]',
		);
		const radar = hero?.querySelector("img");
		const buttons = [hero, locks]
			.flatMap((section) =>
				section
					? Array.from(section.querySelectorAll('[data-slot="button"]'))
					: [],
			)
			.filter(
				(el) =>
					el.getClientRects().length > 0 &&
					getComputedStyle(el).visibility !== "hidden",
			)
			.map((el) => {
				const box = el.getBoundingClientRect();
				return {
					label:
						el.getAttribute("aria-label") ??
						(el.textContent ?? "").replace(/\s+/g, " ").trim(),
					width: round(box.width),
					height: round(box.height),
				};
			});
		return {
			innerWidth: window.innerWidth,
			balance:
				balance && rect
					? {
							fontSize: Number.parseFloat(getComputedStyle(balance).fontSize),
							right: round(rect.right),
						}
					: null,
			radarShown: !!radar && radar.getClientRects().length > 0,
			buttons,
		};
	}, null);
}

walletTest(
	"overview on phones: a large balance and 44px actions",
	async (browser) => {
		const problems = new LayoutProblems();
		for (const viewport of PHONE_VIEWPORTS) {
			const where = `/wallet at ${describeViewport(viewport)}`;
			await setViewport(browser, viewport);
			await waitForSettledPage(browser, "/wallet", null, CHAIN_TIMEOUT);
			await checkNoSidewaysScroll(browser, where, problems);
			const g = await measureOverview(browser);

			if (!g.balance) {
				problems.add(`${where}: no [data-testid="wallet-balance"] shown.`);
			} else {
				if (g.balance.fontSize < MIN_BALANCE_FONT) {
					problems.add(
						`${where}: balance font-size is ${g.balance.fontSize}px, expected at least ${MIN_BALANCE_FONT}px.`,
					);
				}
				if (g.balance.right > g.innerWidth + TOLERANCE) {
					problems.add(
						`${where}: balance right edge is ${g.balance.right}px, expected at most window.innerWidth ${g.innerWidth}px.`,
					);
				}
			}
			if (g.radarShown) {
				problems.add(
					`${where}: the radar image is shown, expected it hidden on phones.`,
				);
			}
			for (const name of ["Send", "Receive"]) {
				if (!g.buttons.some((b) => b.label === name)) {
					problems.add(`${where}: no "${name}" button beside the balance.`);
				}
			}
			for (const button of g.buttons) {
				if (button.height < MIN_TAP_TARGET) {
					problems.add(
						`${where}: button "${button.label}" is ${button.height}px tall (${button.width}px wide), expected at least ${MIN_TAP_TARGET}px.`,
					);
				}
			}
		}
		problems.throwIfAny("Wallet overview on phones");
	},
);

/** A dialog locator; its name is the title waited on. */
type DialogLocator = Locator & { name: string };

const SHEETS: readonly { trigger: Locator; dialog: DialogLocator }[] = [
	{
		trigger: { role: "button", name: "Receive", within: balanceRegion },
		dialog: { role: "dialog", name: "Receive BSV" },
	},
	{
		trigger: { role: "button", name: "Send", within: balanceRegion },
		dialog: { role: "dialog", name: "Send BSV" },
	},
	{
		trigger: { role: "button", name: "Lock BSV", within: locksRegion },
		dialog: { role: "dialog", name: "Lock BSV" },
	},
];

walletTest(
	"overview sheets on phones: Receive, Send and Lock BSV",
	async (browser) => {
		const problems = new LayoutProblems();
		for (const viewport of PHONE_VIEWPORTS) {
			await setViewport(browser, viewport);
			for (const { trigger, dialog } of SHEETS) {
				const where = `${dialog.name} at ${describeViewport(viewport)}`;
				await browser.click(trigger, CHAIN_TIMEOUT);
				await waitForOpenDialog(browser, dialog.name);
				const geometry = await measureOpenDialog(browser);
				const footerButtons = checkBottomSheet(geometry, where, problems);
				// Send and Lock BSV put their primary action in a DialogFooter.
				if (
					dialog.name !== "Receive BSV" &&
					geometry.count === 1 &&
					footerButtons === 0
				) {
					problems.add(
						`${where}: measured 0 buttons in [data-slot="dialog-footer"], expected the review button there.`,
					);
				}
				await browser.press("Escape");
				await browser.waitUntil(
					`the "${dialog.name}" dialog to close`,
					dialog,
					(result) => result.count === 0,
				);
			}
		}
		problems.throwIfAny("Overview sheets on phones");
	},
);

interface ReviewGeometry {
	detailRows: number;
	footers: {
		width: number;
		buttons: { label: string; width: number; height: number }[];
	}[];
}

/** The review state of the one open sheet: its DetailList and footer. */
function measureReview(browser: Browser): Promise<ReviewGeometry> {
	return browser.evaluate(() => {
		const round = (n: number) => Math.round(n * 10) / 10;
		const dialog = Array.from(
			document.querySelectorAll(
				'[data-slot="dialog-content"][data-state="open"]',
			),
		).find((el) => el.getClientRects().length > 0);
		return {
			detailRows:
				dialog?.querySelectorAll(
					'[data-slot="detail-list"] [data-slot="detail-row"]',
				).length ?? 0,
			footers: Array.from(
				dialog?.querySelectorAll('[data-slot="dialog-footer"]') ?? [],
				(footer) => ({
					width: round(footer.getBoundingClientRect().width),
					buttons: Array.from(footer.querySelectorAll("button"))
						.filter((el) => el.getClientRects().length > 0)
						.map((el) => {
							const box = el.getBoundingClientRect();
							return {
								label: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
								width: round(box.width),
								height: round(box.height),
							};
						}),
				}),
			),
		};
	}, null);
}

function checkReview(
	g: ReviewGeometry,
	where: string,
	confirmLabel: string,
	problems: LayoutProblems,
) {
	if (g.detailRows === 0) {
		problems.add(
			`${where}: no [data-slot="detail-row"] in a [data-slot="detail-list"], expected the review as a DetailList.`,
		);
	}
	const buttons = g.footers.flatMap((footer) =>
		footer.buttons.map((button) => ({ ...button, footer: footer.width })),
	);
	const labels = buttons.map((button) => button.label);
	if (
		g.footers.length !== 1 ||
		buttons.length !== 2 ||
		!labels.includes("Back") ||
		!labels.includes(confirmLabel)
	) {
		problems.add(
			`${where}: footer buttons are [${labels.map((l) => `"${l}"`).join(", ")}] in ${g.footers.length} footer(s), expected "Back" and "${confirmLabel}" in one DialogFooter.`,
		);
	}
	for (const button of buttons) {
		if (button.height < MIN_TAP_TARGET) {
			problems.add(
				`${where}: footer button "${button.label}" is ${button.height}px tall, expected at least ${MIN_TAP_TARGET}px.`,
			);
		}
		if (Math.abs(button.width - button.footer) > TOLERANCE) {
			problems.add(
				`${where}: footer button "${button.label}" is ${button.width}px wide, expected the footer's ${button.footer}px.`,
			);
		}
	}
}

/** The smallest amounts each sheet accepts. Neither is ever confirmed. */
const SEND_AMOUNT = "0.00000001";
const LOCK_AMOUNT = "0.00001";

walletTest(
	"overview review steps on phones: Send and Lock BSV, never confirmed",
	async (browser) => {
		const problems = new LayoutProblems();
		// Sending to the wallet's own address, so a stray confirm would cost
		// only the fee. The test only reaches the review and goes Back.
		const address = await readDepositAddress(browser);
		await setViewport(browser, PHONE_VIEWPORTS[0]);

		const reviews: readonly {
			trigger: Locator;
			dialog: DialogLocator;
			fill: () => Promise<void>;
			review: string;
			confirm: string;
		}[] = [
			{
				trigger: { role: "button", name: "Send", within: balanceRegion },
				dialog: { role: "dialog", name: "Send BSV" },
				fill: async () => {
					const dialog: Locator = { role: "dialog", name: "Send BSV" };
					await browser.fill(
						{ role: "textbox", name: "Recipient", within: dialog },
						address,
					);
					await browser.fill(
						{ role: "textbox", name: "Amount (BSV)", within: dialog },
						SEND_AMOUNT,
					);
				},
				review: "Review payment",
				confirm: "Confirm and send",
			},
			{
				trigger: { role: "button", name: "Lock BSV", within: locksRegion },
				dialog: { role: "dialog", name: "Lock BSV" },
				fill: async () => {
					await browser.fill(
						{
							role: "textbox",
							name: "Amount (BSV)",
							within: { role: "dialog", name: "Lock BSV" },
						},
						LOCK_AMOUNT,
					);
				},
				review: "Review lock",
				confirm: "Confirm and lock",
			},
		];

		for (const { trigger, dialog, fill, review, confirm } of reviews) {
			await setViewport(browser, PHONE_VIEWPORTS[0]);
			await browser.click(trigger, CHAIN_TIMEOUT);
			await waitForOpenDialog(browser, dialog.name);
			await fill();
			await browser.click({ role: "button", name: review, within: dialog });
			const confirmButton: Locator = {
				role: "button",
				name: confirm,
				within: dialog,
			};
			await browser.waitUntil(
				`the ${dialog.name} review`,
				confirmButton,
				undefined,
				undefined,
				CHAIN_TIMEOUT,
			);
			for (const viewport of PHONE_VIEWPORTS) {
				await setViewport(browser, viewport);
				const where = `${dialog.name} review at ${describeViewport(viewport)}`;
				checkReview(await measureReview(browser), where, confirm, problems);
				checkBottomSheet(await measureOpenDialog(browser), where, problems);
			}
			// Back to the form, then close: nothing is signed or broadcast.
			await browser.click({ role: "button", name: "Back", within: dialog });
			await browser.waitUntil(`the ${dialog.name} form`, {
				role: "button",
				name: review,
				within: dialog,
			});
			const stillReviewing = await browser.query(confirmButton);
			if (stillReviewing.count > 0) {
				throw new Error(`${dialog.name} stayed on its review after Back.`);
			}
			await browser.press("Escape");
			await browser.waitUntil(
				`the "${dialog.name}" dialog to close`,
				dialog,
				(result) => result.count === 0,
			);
		}
		problems.throwIfAny("Overview review steps on phones");
	},
);

interface UnlockGeometry {
	innerWidth: number;
	innerHeight: number;
	card: { left: number; right: number; top: number; bottom: number } | null;
	label: boolean;
	input: number | null;
	button: number | null;
}

function measureUnlock(browser: Browser): Promise<UnlockGeometry> {
	return browser.evaluate(() => {
		const round = (n: number) => Math.round(n * 10) / 10;
		const screen = document.querySelector(
			'[role="dialog"][aria-label="Unlock wallet"]',
		);
		const card = screen?.querySelector('[data-slot="card"]');
		const rect = card?.getBoundingClientRect();
		const label = screen?.querySelector('label[for="passphrase"]');
		const input = screen?.querySelector("#passphrase");
		const button = screen?.querySelector('button[type="submit"]');
		return {
			innerWidth: window.innerWidth,
			innerHeight: window.innerHeight,
			card: rect
				? {
						left: round(rect.left),
						right: round(rect.right),
						top: round(rect.top),
						bottom: round(rect.bottom),
					}
				: null,
			label:
				!!label &&
				label.getBoundingClientRect().width > 1 &&
				label.getBoundingClientRect().height > 1,
			input: input ? round(input.getBoundingClientRect().height) : null,
			button: button ? round(button.getBoundingClientRect().height) : null,
		};
	}, null);
}

function checkUnlock(
	g: UnlockGeometry,
	viewport: Viewport,
	phone: boolean,
	problems: LayoutProblems,
) {
	const where = `Unlock screen at ${describeViewport(viewport)}`;
	if (!g.card) {
		problems.add(`${where}: no card on the unlock screen.`);
		return;
	}
	const { card } = g;
	if (
		card.left < -TOLERANCE ||
		card.top < -TOLERANCE ||
		card.right > g.innerWidth + TOLERANCE ||
		card.bottom > g.innerHeight + TOLERANCE
	) {
		problems.add(
			`${where}: card is at left ${card.left}, top ${card.top}, right ${card.right}, bottom ${card.bottom}, expected it inside the ${g.innerWidth}x${g.innerHeight} window.`,
		);
	}
	if (phone) {
		// A bottom sheet: full width, resting on the bottom edge.
		if (
			Math.abs(card.left) > TOLERANCE ||
			Math.abs(card.right - g.innerWidth) > TOLERANCE ||
			Math.abs(card.bottom - g.innerHeight) > TOLERANCE
		) {
			problems.add(
				`${where}: card is at left ${card.left}, right ${card.right}, bottom ${card.bottom}, expected a full-width sheet on the bottom edge (0, ${g.innerWidth}, ${g.innerHeight}).`,
			);
		}
		if (g.input === null || g.input < MIN_TAP_TARGET) {
			problems.add(
				`${where}: passphrase field is ${g.input}px tall, expected at least ${MIN_TAP_TARGET}px.`,
			);
		}
		if (g.button === null || g.button < MIN_TAP_TARGET) {
			problems.add(
				`${where}: Unlock button is ${g.button}px tall, expected at least ${MIN_TAP_TARGET}px.`,
			);
		}
	} else {
		const leftMargin = card.left;
		const rightMargin = g.innerWidth - card.right;
		if (Math.abs(leftMargin - rightMargin) > TOLERANCE) {
			problems.add(
				`${where}: card is not centered: left margin ${leftMargin}px, right margin ${rightMargin}px.`,
			);
		}
	}
	if (!g.label) {
		problems.add(`${where}: the "Passphrase" label is not shown.`);
	}
}

walletTest(
	"unlock screen: a bottom sheet on phones, centered on desktop",
	async (browser) => {
		const problems = new LayoutProblems();
		const unlockScreen: Locator = { role: "dialog", name: "Unlock wallet" };
		await setViewport(browser, PHONE_VIEWPORTS[0]);
		// A page load locks the wallet again.
		await browser.open(new URL("/wallet", baseUrl().origin).href);
		await browser.waitUntil(
			"the unlock screen",
			unlockScreen,
			undefined,
			undefined,
			CHAIN_TIMEOUT,
		);
		for (const viewport of [...PHONE_VIEWPORTS, DESKTOP_VIEWPORT]) {
			await setViewport(browser, viewport);
			// The card's enter animation is over before it is measured.
			await browser.waitFor(
				"the unlock card to finish animating",
				() => {
					const card = document.querySelector(
						'[aria-label="Unlock wallet"] [data-slot="card"]',
					);
					return (
						!!card &&
						card
							.getAnimations()
							.every((animation) => animation.playState === "finished")
					);
				},
				null,
			);
			checkUnlock(
				await measureUnlock(browser),
				viewport,
				viewport !== DESKTOP_VIEWPORT,
				problems,
			);
		}
		await unlockWallet(browser);
		problems.throwIfAny("Unlock screen");
	},
);
