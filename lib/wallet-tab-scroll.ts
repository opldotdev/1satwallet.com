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
	const max = Math.max(0, row.scrollWidth - row.clientWidth);
	const tabStart = row.scrollLeft + (tab.left - row.left);
	const target = tabStart - (row.clientWidth - tab.width) / 2;
	return Math.min(max, Math.max(0, target));
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
