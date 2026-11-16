import type { Browser } from "./agent-browser";

/*
 * Layout measurements for the mobile layout specs. Every function handed to
 * `browser.evaluate` or `browser.waitFor` is sent to the page as source, so
 * it stays self-contained: no imports and no outer references.
 */

export interface Viewport {
	width: number;
	height: number;
}

/** iPhone SE, iPhone 14, iPhone 14 Pro Max (CSS pixels). */
export const PHONE_VIEWPORTS: readonly Viewport[] = [
	{ width: 375, height: 667 },
	{ width: 390, height: 844 },
	{ width: 430, height: 932 },
];

export const DESKTOP_VIEWPORT: Viewport = { width: 1280, height: 800 };

/** The smallest tap target on a phone (Apple HIG, WCAG 2.5.5). */
export const MIN_TAP_TARGET = 44;

/** A bottom sheet leaves this much of the page showing above it. */
export const SHEET_TOP_GAP = 48;

/** Allowed difference for every geometry comparison, in CSS pixels. */
export const TOLERANCE = 1;

export const describeViewport = ({ width, height }: Viewport) =>
	`${width}x${height}`;

/** Layout problems of one test, thrown together so none hides another. */
export class LayoutProblems {
	private readonly problems: string[] = [];

	add(problem: string) {
		this.problems.push(problem);
	}

	/** Throws once, listing every problem, if there are any. */
	throwIfAny(subject: string) {
		if (this.problems.length === 0) return;
		throw new Error(
			`${subject}: ${this.problems.length} layout problem${this.problems.length === 1 ? "" : "s"}:\n- ${this.problems.join("\n- ")}`,
		);
	}
}

/** Resizes the page and waits until the page itself reports the new size. */
export async function setViewport(browser: Browser, viewport: Viewport) {
	await browser.setViewport(viewport.width, viewport.height);
	try {
		await browser.waitFor(
			`the window to be ${describeViewport(viewport)}`,
			(size: { width: number; height: number }) =>
				window.innerWidth === size.width && window.innerHeight === size.height,
			viewport,
		);
	} catch (error) {
		const actual = await browser.evaluate(
			() => `${window.innerWidth}x${window.innerHeight}`,
			null,
		);
		throw new Error(
			`The window is ${actual} after setting the viewport to ${describeViewport(viewport)}.`,
			{ cause: error },
		);
	}
}

/** Waits until `pathname` is showing with no loading skeleton left. */
export async function waitForSettledPage(
	browser: Browser,
	pathname: string,
	readySelector: string | null,
	timeout?: number,
) {
	await browser.waitFor(
		`${pathname} to finish loading${readySelector ? ` (${readySelector} on the page)` : ""}`,
		(args: { pathname: string; readySelector: string | null }) =>
			document.readyState === "complete" &&
			location.pathname === args.pathname &&
			(args.readySelector === null ||
				document.querySelector(args.readySelector) !== null) &&
			!Array.from(document.querySelectorAll('[data-slot="skeleton"]')).some(
				(el) => el.getClientRects().length > 0,
			),
		{ pathname, readySelector },
		timeout,
	);
}

/** Records a problem if the page is wider than the window. */
export async function checkNoSidewaysScroll(
	browser: Browser,
	where: string,
	problems: LayoutProblems,
) {
	const { scrollWidth, innerWidth, widest } = await browser.evaluate(() => {
		const viewport = window.innerWidth;
		const scrollWidth = document.documentElement.scrollWidth;
		if (scrollWidth <= viewport) {
			return { scrollWidth, innerWidth: viewport, widest: null };
		}
		// The element reaching furthest right, to name in the failure. It
		// may sit in a scroll container; it is a lead, not the verdict.
		let widest: string | null = null;
		let furthest = viewport;
		for (const el of Array.from(document.body.querySelectorAll("*"))) {
			const right = el.getBoundingClientRect().right + window.scrollX;
			if (right > furthest) {
				furthest = right;
				const label =
					el.getAttribute("data-slot") ??
					el.getAttribute("aria-label") ??
					(el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
				widest = `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}> "${label}" right edge ${Math.round(right)}`;
			}
		}
		return { scrollWidth, innerWidth: viewport, widest };
	}, null);
	if (scrollWidth > innerWidth) {
		problems.add(
			`${where}: the page scrolls sideways: document scrollWidth ${scrollWidth}px, expected at most window.innerWidth ${innerWidth}px${widest ? `; widest element ${widest}` : ""}.`,
		);
	}
}

/** Records a problem unless the viewport meta tag has viewport-fit=cover. */
export async function checkViewportFitCover(
	browser: Browser,
	where: string,
	problems: LayoutProblems,
) {
	const contents = await browser.evaluate(
		() =>
			Array.from(
				document.querySelectorAll('meta[name="viewport"]'),
				(meta) => meta.getAttribute("content") ?? "",
			),
		null,
	);
	if (!contents.some((content) => /viewport-fit\s*=\s*cover/.test(content))) {
		problems.add(
			`${where}: meta[name=viewport] content is ${contents.length ? contents.map((c) => `"${c}"`).join(", ") : "missing"}, expected it to contain "viewport-fit=cover".`,
		);
	}
}

const TAP_TARGET_SLOTS = ["button", "input", "select-trigger"] as const;

/**
 * Records a problem for every visible button, input and select trigger
 * shorter than the minimum tap target. Screen-reader-only elements (clipped
 * to 1px or less) are not tap targets and are skipped.
 */
export async function checkTapTargets(
	browser: Browser,
	where: string,
	problems: LayoutProblems,
) {
	const small = await browser.evaluate(
		(args: { slots: readonly string[]; min: number }) => {
			const out: { label: string; width: number; height: number }[] = [];
			const selector = args.slots
				.map((slot) => `[data-slot="${slot}"]`)
				.join(",");
			for (const el of Array.from(document.querySelectorAll(selector))) {
				if (el.getClientRects().length === 0) continue;
				if (getComputedStyle(el).visibility === "hidden") continue;
				// Inert or hidden subtrees (the connect carousel's scaled-down side
				// cards) can't be tapped, so they are not tap targets.
				if (el.closest('[inert], [aria-hidden="true"]')) continue;
				const rect = el.getBoundingClientRect();
				if (rect.width <= 1 && rect.height <= 1) continue;
				if (rect.height >= args.min) continue;
				const name =
					el.getAttribute("aria-label") ??
					((el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40) ||
						el.getAttribute("placeholder") ||
						el.getAttribute("title") ||
						"(no name)");
				out.push({
					label: `${el.getAttribute("data-slot")} "${name}"`,
					width: Math.round(rect.width * 10) / 10,
					height: Math.round(rect.height * 10) / 10,
				});
			}
			return out;
		},
		{ slots: TAP_TARGET_SLOTS, min: MIN_TAP_TARGET },
	);
	for (const target of small) {
		problems.add(
			`${where}: ${target.label} is ${target.height}px tall (${target.width}px wide), expected at least ${MIN_TAP_TARGET}px.`,
		);
	}
}

/**
 * Desktop type and density: the phone-only 44px minimum does not reach
 * desktop (every default-size button has no min-height), and no h1 is set in
 * JetBrains Mono. Returns how many default-size buttons it measured. A
 * default-size button carries the size variant's `h-9 px-4 py-2`
 * (components/ui/button.tsx). Its rendered height is not checked: a screen's
 * own CSS may size it (the connect carousel's actions are 44px on purpose).
 */
export async function checkDesktopDensity(
	browser: Browser,
	where: string,
	problems: LayoutProblems,
): Promise<number> {
	const { buttons, headings } = await browser.evaluate(() => {
		const clean = (text: string | null) =>
			(text ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
		const buttons = Array.from(
			document.querySelectorAll('[data-slot="button"]'),
		)
			.filter(
				(el) =>
					el.getClientRects().length > 0 &&
					getComputedStyle(el).visibility !== "hidden" &&
					!el.closest('[inert], [aria-hidden="true"]') &&
					["h-9", "px-4", "py-2"].every((token) =>
						el.classList.contains(token),
					),
			)
			.map((el) => ({
				label: el.getAttribute("aria-label") ?? clean(el.textContent),
				minHeight: getComputedStyle(el).minHeight,
			}));
		const headings = Array.from(document.querySelectorAll("h1"), (el) => ({
			text: clean(el.textContent),
			fontFamily: getComputedStyle(el).fontFamily,
		}));
		return { buttons, headings };
	}, null);

	for (const button of buttons) {
		if (button.minHeight !== "0px" && button.minHeight !== "auto") {
			problems.add(
				`${where}: default-size button "${button.label}" has min-height ${button.minHeight}, expected none on desktop (the 44px minimum is for phones only).`,
			);
		}
	}
	if (headings.length === 0) {
		problems.add(`${where}: found no h1, expected one to check its font.`);
	}
	for (const heading of headings) {
		// next/font names it "JetBrains Mono" or "__JetBrains_Mono_<hash>".
		if (/jetbrains[\s_]*mono/i.test(heading.fontFamily)) {
			problems.add(
				`${where}: h1 "${heading.text}" font-family is ${heading.fontFamily}, expected no JetBrains Mono.`,
			);
		}
	}
	return buttons.length;
}

export interface DialogGeometry {
	/** Open dialogs ([data-slot=dialog-content][data-state=open]) on screen. */
	count: number;
	left: number;
	right: number;
	top: number;
	bottom: number;
	height: number;
	overflowY: string;
	innerWidth: number;
	innerHeight: number;
	clientWidth: number;
	close: { width: number; height: number } | null;
	footers: { width: number; buttons: { label: string; width: number }[] }[];
}

/**
 * Waits until exactly one dialog is open and its enter animation is over,
 * so its box is where it rests, not mid-slide or mid-zoom.
 */
export async function waitForOpenDialog(browser: Browser, title: string) {
	await browser.waitFor(
		`the "${title}" dialog to finish opening`,
		(expected: string) => {
			const open = Array.from(
				document.querySelectorAll(
					'[data-slot="dialog-content"][data-state="open"]',
				),
			).filter((el) => el.getClientRects().length > 0);
			if (open.length !== 1) return false;
			const [dialog] = open;
			// The title may sit outside the content (the command palette puts
			// its header beside it); aria-labelledby names it either way.
			const labelId = dialog.getAttribute("aria-labelledby");
			const title =
				dialog.querySelector('[data-slot="dialog-title"]') ??
				(labelId ? document.getElementById(labelId) : null);
			const shown = (title?.textContent ?? "").trim();
			return (
				shown === expected &&
				dialog
					.getAnimations()
					.every((animation) => animation.playState === "finished")
			);
		},
		title,
	);
}

/** Measures the one open dialog, its close button and its footers. */
export function measureOpenDialog(browser: Browser): Promise<DialogGeometry> {
	return browser.evaluate(() => {
		const round = (n: number) => Math.round(n * 100) / 100;
		const open = Array.from(
			document.querySelectorAll(
				'[data-slot="dialog-content"][data-state="open"]',
			),
		).filter((el) => el.getClientRects().length > 0);
		const dialog = open[0];
		const rect = dialog?.getBoundingClientRect();
		const close = dialog?.querySelector('[data-slot="dialog-close"]');
		const closeRect = close?.getBoundingClientRect();
		const footers = dialog
			? Array.from(
					dialog.querySelectorAll('[data-slot="dialog-footer"]'),
					(footer) => ({
						width: round(footer.getBoundingClientRect().width),
						buttons: Array.from(
							footer.querySelectorAll('button,[data-slot="button"]'),
						)
							.filter((el) => el.getClientRects().length > 0)
							.map((el) => ({
								label: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
								width: round(el.getBoundingClientRect().width),
							})),
					}),
				)
			: [];
		return {
			count: open.length,
			left: round(rect?.left ?? Number.NaN),
			right: round(rect?.right ?? Number.NaN),
			top: round(rect?.top ?? Number.NaN),
			bottom: round(rect?.bottom ?? Number.NaN),
			height: round(rect?.height ?? Number.NaN),
			overflowY: dialog ? getComputedStyle(dialog).overflowY : "",
			innerWidth: window.innerWidth,
			innerHeight: window.innerHeight,
			clientWidth: document.documentElement.clientWidth,
			close: closeRect
				? { width: round(closeRect.width), height: round(closeRect.height) }
				: null,
			footers,
		};
	}, null);
}

/**
 * The close control sits in the dialog's top-right corner: 4px in from the
 * padding edge plus the 1px border, so 5px. Anything past this is a misplaced
 * control (a sticky offset counted from inside the padding puts it 20-28px
 * down).
 */
export const CLOSE_CORNER_OFFSET = 8;

/** The viewports the close control's corner is checked at. */
export const CLOSE_CHECK_VIEWPORTS: readonly Viewport[] = [
	{ width: 390, height: 844 },
	DESKTOP_VIEWPORT,
];

interface CloseControlPlacement {
	count: number;
	dialog: { top: number; right: number };
	close: { top: number; right: number } | null;
	scrollTop: number;
	maxScrollTop: number;
	/** The dialog scrolls itself (overflow-y auto or scroll) and overflows. */
	scrollable: boolean;
}

function measureCloseControl(browser: Browser): Promise<CloseControlPlacement> {
	return browser.evaluate(() => {
		const round = (n: number) => Math.round(n * 100) / 100;
		const open = Array.from(
			document.querySelectorAll(
				'[data-slot="dialog-content"][data-state="open"]',
			),
		).filter((el) => el.getClientRects().length > 0);
		const dialog = open[0];
		const rect = dialog?.getBoundingClientRect();
		const close = dialog
			?.querySelector('[data-slot="dialog-close"]')
			?.getBoundingClientRect();
		const overflowY = dialog ? getComputedStyle(dialog).overflowY : "";
		const maxScrollTop = dialog ? dialog.scrollHeight - dialog.clientHeight : 0;
		return {
			count: open.length,
			dialog: {
				top: round(rect?.top ?? Number.NaN),
				right: round(rect?.right ?? Number.NaN),
			},
			close: close
				? { top: round(close.top), right: round(close.right) }
				: null,
			scrollTop: round(dialog?.scrollTop ?? 0),
			maxScrollTop: round(maxScrollTop),
			scrollable:
				(overflowY === "auto" || overflowY === "scroll") && maxScrollTop > 1,
		};
	}, null);
}

function checkCloseCorner(
	m: CloseControlPlacement,
	where: string,
	problems: LayoutProblems,
) {
	if (m.count !== 1) {
		problems.add(`${where}: ${m.count} open dialogs, expected 1.`);
		return;
	}
	if (!m.close) {
		problems.add(
			`${where}: no [data-slot="dialog-close"] in the dialog, expected a close button.`,
		);
		return;
	}
	const fromTop = Math.round((m.close.top - m.dialog.top) * 100) / 100;
	if (fromTop < 0 || fromTop > CLOSE_CORNER_OFFSET) {
		problems.add(
			`${where}: close button top is ${m.close.top}px, ${fromTop}px below the dialog top ${m.dialog.top}px, expected 0-${CLOSE_CORNER_OFFSET}px below it.`,
		);
	}
	const fromRight = Math.round((m.dialog.right - m.close.right) * 100) / 100;
	if (fromRight < 0 || fromRight > CLOSE_CORNER_OFFSET) {
		problems.add(
			`${where}: close button right is ${m.close.right}px, ${fromRight}px in from the dialog right ${m.dialog.right}px, expected 0-${CLOSE_CORNER_OFFSET}px in from it.`,
		);
	}
}

/**
 * Checks that the open dialog's close control is in its top-right corner at
 * rest and, when the dialog overflows, still there once the content is
 * scrolled to the bottom (the control is sticky). Returns whether the
 * scrolled case was measured.
 */
export async function checkCloseControlCorner(
	browser: Browser,
	where: string,
	problems: LayoutProblems,
): Promise<boolean> {
	const atRest = await measureCloseControl(browser);
	checkCloseCorner(atRest, `${where}, at rest`, problems);
	if (atRest.count !== 1 || !atRest.scrollable) return false;

	await browser.evaluate(() => {
		const dialog = Array.from(
			document.querySelectorAll(
				'[data-slot="dialog-content"][data-state="open"]',
			),
		).find((el) => el.getClientRects().length > 0);
		if (dialog) dialog.scrollTop = dialog.scrollHeight;
	}, null);
	await browser.waitFor(
		`${where}: the dialog to scroll to the bottom`,
		() => {
			const dialog = Array.from(
				document.querySelectorAll(
					'[data-slot="dialog-content"][data-state="open"]',
				),
			).find((el) => el.getClientRects().length > 0);
			return (
				!!dialog &&
				dialog.scrollTop > 0 &&
				dialog.scrollHeight - dialog.clientHeight - dialog.scrollTop <= 1
			);
		},
		null,
	);
	const scrolled = await measureCloseControl(browser);
	checkCloseCorner(
		scrolled,
		`${where}, scrolled to the bottom (scrollTop ${scrolled.scrollTop} of ${scrolled.maxScrollTop})`,
		problems,
	);
	return true;
}

/**
 * Phone checks: a full-width bottom sheet that leaves the top of the page
 * showing, scrolls inside, has a 44px close button and full-width footer
 * buttons. Returns how many footer buttons it measured.
 */
export function checkBottomSheet(
	g: DialogGeometry,
	where: string,
	problems: LayoutProblems,
): number {
	if (g.count !== 1) {
		problems.add(`${where}: ${g.count} open dialogs, expected 1.`);
		return 0;
	}
	const near = (actual: number, expected: number) =>
		Math.abs(actual - expected) <= TOLERANCE;
	if (!near(g.left, 0)) {
		problems.add(`${where}: dialog left is ${g.left}px, expected 0.`);
	}
	if (!near(g.right, g.innerWidth)) {
		problems.add(
			`${where}: dialog right is ${g.right}px, expected window.innerWidth ${g.innerWidth}px.`,
		);
	}
	if (!near(g.bottom, g.innerHeight)) {
		problems.add(
			`${where}: dialog bottom is ${g.bottom}px, expected window.innerHeight ${g.innerHeight}px.`,
		);
	}
	if (g.top < 0) {
		problems.add(`${where}: dialog top is ${g.top}px, expected at least 0.`);
	}
	const maxHeight = g.innerHeight - SHEET_TOP_GAP;
	if (g.height > maxHeight + TOLERANCE) {
		problems.add(
			`${where}: dialog is ${g.height}px tall, expected at most ${maxHeight}px (window.innerHeight ${g.innerHeight} - ${SHEET_TOP_GAP}).`,
		);
	}
	if (g.overflowY !== "auto") {
		problems.add(
			`${where}: dialog overflow-y is "${g.overflowY}", expected "auto".`,
		);
	}
	if (!g.close) {
		problems.add(
			`${where}: no [data-slot="dialog-close"] in the dialog, expected a close button.`,
		);
	} else if (
		g.close.width < MIN_TAP_TARGET ||
		g.close.height < MIN_TAP_TARGET
	) {
		problems.add(
			`${where}: close button is ${g.close.width}x${g.close.height}px, expected at least ${MIN_TAP_TARGET}x${MIN_TAP_TARGET}px.`,
		);
	}
	let measured = 0;
	for (const footer of g.footers) {
		for (const button of footer.buttons) {
			measured++;
			if (!near(button.width, footer.width)) {
				problems.add(
					`${where}: footer button "${button.label}" is ${button.width}px wide, expected the footer's ${footer.width}px.`,
				);
			}
		}
	}
	return measured;
}

/** Desktop check: a centered dialog (equal left and right margins). */
export function checkCenteredDialog(
	g: DialogGeometry,
	where: string,
	problems: LayoutProblems,
) {
	if (g.count !== 1) {
		problems.add(`${where}: ${g.count} open dialogs, expected 1.`);
		return;
	}
	const leftMargin = g.left;
	const rightMargin = g.innerWidth - g.right;
	if (Math.abs(leftMargin - rightMargin) > TOLERANCE) {
		problems.add(
			`${where}: dialog is not centered: left margin ${leftMargin}px, right margin ${Math.round(rightMargin * 100) / 100}px (window.innerWidth ${g.innerWidth}, documentElement.clientWidth ${g.clientWidth}), expected them within ${TOLERANCE}px.`,
		);
	}
}
