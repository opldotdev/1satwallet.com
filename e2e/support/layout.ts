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

/** A default-size button (shadcn `h-9`) on desktop. */
export const DESKTOP_DEFAULT_BUTTON_HEIGHT = 36;

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
 * Desktop type and density: every default-size button is 36px tall and no
 * h1 is set in JetBrains Mono. Returns how many default-size buttons it
 * measured. A default-size button carries the size variant's `h-9 px-4 py-2`
 * (components/ui/button.tsx); a className height override removes `h-9`.
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
					["h-9", "px-4", "py-2"].every((token) =>
						el.classList.contains(token),
					),
			)
			.map((el) => ({
				label: el.getAttribute("aria-label") ?? clean(el.textContent),
				height: Math.round(el.getBoundingClientRect().height * 10) / 10,
			}));
		const headings = Array.from(document.querySelectorAll("h1"), (el) => ({
			text: clean(el.textContent),
			fontFamily: getComputedStyle(el).fontFamily,
		}));
		return { buttons, headings };
	}, null);

	for (const button of buttons) {
		if (Math.abs(button.height - DESKTOP_DEFAULT_BUTTON_HEIGHT) > TOLERANCE) {
			problems.add(
				`${where}: default-size button "${button.label}" is ${button.height}px tall, expected ${DESKTOP_DEFAULT_BUTTON_HEIGHT}px.`,
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
			const shown = (
				dialog.querySelector('[data-slot="dialog-title"]')?.textContent ?? ""
			).trim();
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
