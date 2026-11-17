/**
 * The arithmetic behind centring the current wallet tab in its row. The row
 * is a horizontal scroller; rects are viewport rects (getBoundingClientRect).
 */

/** The scroller's own box and scroll range. */
export interface TabRow {
	/** The row's left edge in the viewport. */
	left: number;
	scrollLeft: number;
	clientWidth: number;
	scrollWidth: number;
}

export interface Span {
	left: number;
	right: number;
}

/**
 * The scrollLeft that centres `tab` in `row`, kept within the row's scroll
 * range: the first tabs sit at the start and the last ones at the end.
 */
export function centredScrollLeft(
	row: TabRow,
	tab: { left: number; width: number },
): number {
	const tabStart = row.scrollLeft + (tab.left - row.left);
	return clampScrollLeft(row, tabStart - (row.clientWidth - tab.width) / 2);
}

/** `left` kept within the row's scroll range, as the browser would clamp it. */
function clampScrollLeft(row: TabRow, left: number): number {
	const max = Math.max(0, row.scrollWidth - row.clientWidth);
	return Math.min(max, Math.max(0, left));
}

/** Whether `tab` sits wholly inside `row`'s box, within `tolerance` px. */
export function tabInView(tab: Span, row: Span, tolerance = 1): boolean {
	return tab.left >= row.left - tolerance && tab.right <= row.right + tolerance;
}

/** How long the glide to the current tab takes, in ms: short hops are quick. */
export function glideDuration(distance: number): number {
	return Math.round(Math.min(400, Math.max(150, 150 + Math.abs(distance))));
}

/**
 * Where the glide from `from` to `to` is after `elapsed` of `duration` ms,
 * easing out. At or past the end it is exactly `to`.
 */
export function glidePosition(
	from: number,
	to: number,
	elapsed: number,
	duration: number,
): number {
	if (duration <= 0 || elapsed >= duration) return to;
	const t = Math.max(0, elapsed) / duration;
	return from + (to - from) * (1 - (1 - t) ** 3);
}

/** A viewport rect: a span with its width. */
export interface Box extends Span {
	width: number;
}

/** The row as it stands now: its scroll state, its box and its current tab. */
export interface RowView {
	row: TabRow;
	box: Box;
	/** The current tab's rect; null when no tab is current. */
	tab: Box | null;
	/** The current tab's href; null when no tab is current. */
	href: string | null;
}

/** One glide of the row towards the tab for `href`. */
export interface Glide {
	href: string;
	from: number;
	target: number;
	duration: number;
}

/** How to centre the current tab when the section changes. */
export type CentrePlan =
	/** No tab is current: nothing to centre. */
	| { type: "none" }
	/** The row or the tab has no size yet: centre it once it has one. */
	| { type: "defer" }
	/** Go straight there: reduced motion, or already there. */
	| { type: "jump"; left: number }
	| { type: "glide"; glide: Glide };

function hasNoSize(box: Box, tab: Box): boolean {
	return box.width === 0 || tab.width === 0;
}

/** Plans the centring of the current tab, instant when `still`. */
export function planCentre(view: RowView, still: boolean): CentrePlan {
	const { tab, href } = view;
	if (tab === null || href === null) return { type: "none" };
	if (hasNoSize(view.box, tab)) return { type: "defer" };
	const from = view.row.scrollLeft;
	const target = centredScrollLeft(view.row, tab);
	if (still || Math.abs(target - from) < 1)
		return { type: "jump", left: target };
	return {
		type: "glide",
		glide: { href, from, target, duration: glideDuration(target - from) },
	};
}

/** What the glide saw since its last frame. */
export interface GlideFrame {
	/** ms since the glide's first frame. */
	elapsed: number;
	/** The scrollLeft the glide last left the row at. */
	written: number;
	/** A finger, pointer, wheel or key went to the row since the glide began. */
	userInput: boolean;
}

/** What one frame of the glide does. */
export type GlideDecision =
	/** Another section is current, or none is: this glide is over. */
	| { type: "stop" }
	/** Someone is scrolling the row: leave it to them. */
	| { type: "yield" }
	/** The row or the tab lost its size: centre it once it has one again. */
	| { type: "defer" }
	/** The layout moved the row (tabs changed, a font swapped, the screen
	 * turned): plan again from where the row is now. */
	| { type: "reaim" }
	/** Scroll to `left` and glide on next frame. */
	| { type: "step"; left: number }
	/** Scroll to `left`, the end of the glide, with the tab in view. */
	| { type: "land"; left: number };

/**
 * Decides one frame of `glide` from the row as it stands. A scroll the glide
 * did not write is the user's only when they touched the row; otherwise it is
 * the layout moving, and the glide plans again rather than leave the tab out
 * of view.
 */
export function glideFrame(
	glide: Glide,
	view: RowView,
	frame: GlideFrame,
): GlideDecision {
	const { tab } = view;
	if (tab === null || view.href !== glide.href) return { type: "stop" };
	if (frame.userInput) return { type: "yield" };
	if (hasNoSize(view.box, tab)) return { type: "defer" };
	if (Math.abs(view.row.scrollLeft - frame.written) > 1)
		return { type: "reaim" };
	if (frame.elapsed < glide.duration) {
		return {
			type: "step",
			left: glidePosition(
				glide.from,
				glide.target,
				frame.elapsed,
				glide.duration,
			),
		};
	}
	return { type: "land", left: landingScrollLeft(glide.target, view, tab) };
}

/**
 * Where the glide lands: on its target if the tab will be in view there,
 * otherwise (the layout moved under the glide) centred on the tab as it is now.
 */
function landingScrollLeft(target: number, view: RowView, tab: Box): number {
	const left = clampScrollLeft(view.row, target);
	const shift = left - view.row.scrollLeft;
	const landed = { left: tab.left - shift, right: tab.right - shift };
	return tabInView(landed, view.box) ? left : centredScrollLeft(view.row, tab);
}
