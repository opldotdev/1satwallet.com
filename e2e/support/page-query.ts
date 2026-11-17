/**
 * In-page element lookup by role and accessible name, in the spirit of
 * Testing Library queries. `pageQuery` is sent to the browser as source, so
 * it must stay self-contained: no imports and no outer references.
 */

const ROLES = {
	alert: '[role="alert"]',
	button: 'button,[role="button"]',
	checkbox: 'input[type="checkbox"],[role="checkbox"]',
	dialog: '[role="dialog"],[role="alertdialog"]',
	img: 'img,[role="img"]',
	link: 'a[href],[role="link"]',
	listitem: 'li,[role="listitem"]',
	navigation: 'nav,[role="navigation"]',
	region: 'section[aria-label],section[aria-labelledby],[role="region"]',
	switch: '[role="switch"]',
	tab: '[role="tab"]',
	textbox: 'input:not([type="checkbox"]):not([type="radio"]),textarea',
	any: "*",
} as const;

export type Role = keyof typeof ROLES;

/** A JSON-safe regular expression. */
export interface Pattern {
	source: string;
	flags: string;
}

export const pattern = (regex: RegExp): Pattern => ({
	source: regex.source,
	flags: regex.flags,
});

/** Matches text that contains `text` (whitespace collapsed). */
export const containing = (text: string): Pattern =>
	pattern(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

export interface Locator {
	role: Role;
	/** Exact accessible name. */
	name?: string;
	/** Text the element's content must match. */
	text?: Pattern;
	/** Text the element's content must not match. */
	notText?: Pattern;
	/** A descendant the element must contain. */
	has?: Locator;
	/** Only elements inside the first visible match of this locator. */
	within?: Locator;
	/** Of several matches, this one (default 0). */
	index?: number;
	/** Attributes of the match to read into the result. */
	attributes?: string[];
}

export interface PageLocator {
	selector: string;
	name?: string;
	text?: Pattern;
	notText?: Pattern;
	has?: PageLocator;
	within?: PageLocator;
	index: number;
}

export function toPageLocator(locator: Locator): PageLocator {
	return {
		selector: ROLES[locator.role],
		name: locator.name,
		text: locator.text,
		notText: locator.notText,
		has: locator.has && toPageLocator(locator.has),
		within: locator.within && toPageLocator(locator.within),
		index: locator.index ?? 0,
	};
}

export interface QueryResult {
	/** Visible matches. */
	count: number;
	text: string | null;
	value: string | null;
	disabled: boolean | null;
	attributes: Record<string, string | null>;
}

export interface QueryArgs {
	locator: PageLocator;
	/** Sets data-e2e-target to this on the match, for agent-browser to act on. */
	mark?: string;
	attributes?: string[];
}

export function pageQuery(args: QueryArgs): QueryResult {
	const clean = (text: string | null) =>
		(text ?? "").replace(/\s+/g, " ").trim();
	const visible = (el: Element) =>
		el.getClientRects().length > 0 &&
		getComputedStyle(el).visibility !== "hidden";
	const nameOf = (el: Element) => {
		const label = el.getAttribute("aria-label");
		if (label) return clean(label);
		const labelledBy = el.getAttribute("aria-labelledby");
		if (labelledBy) {
			return clean(
				labelledBy
					.split(/\s+/)
					.map((id) => document.getElementById(id)?.textContent ?? "")
					.join(" "),
			);
		}
		if ("labels" in el && el.labels instanceof NodeList && el.labels.length) {
			return clean(
				Array.from(el.labels, (node) => node.textContent ?? "").join(" "),
			);
		}
		if (el instanceof HTMLImageElement) return clean(el.alt);
		return clean(el.textContent);
	};
	const test = (p: { source: string; flags: string }, text: string) =>
		new RegExp(p.source, p.flags).test(text);
	const find = (
		locator: QueryArgs["locator"],
		roots: ParentNode[],
	): Element[] => {
		let scope = roots;
		if (locator.within) {
			const outer = find(locator.within, roots)[locator.within.index];
			if (!outer) return [];
			scope = [outer];
		}
		const matches = scope
			.flatMap((root) => Array.from(root.querySelectorAll(locator.selector)))
			.filter(
				(el) =>
					visible(el) &&
					(locator.name === undefined || nameOf(el) === locator.name) &&
					(!locator.text || test(locator.text, clean(el.textContent))) &&
					(!locator.notText || !test(locator.notText, clean(el.textContent))) &&
					(!locator.has || find(locator.has, [el]).length > 0),
			);
		// For a text match, keep the innermost elements.
		return locator.text
			? matches.filter(
					(el) => !matches.some((other) => other !== el && el.contains(other)),
				)
			: matches;
	};

	if (args.mark) {
		for (const old of document.querySelectorAll(
			`[data-e2e-target="${args.mark}"]`,
		)) {
			old.removeAttribute("data-e2e-target");
		}
	}
	const matches = find(args.locator, [document]);
	const el = matches[args.locator.index];
	if (el && args.mark) el.setAttribute("data-e2e-target", args.mark);
	return {
		count: matches.length,
		text: el ? clean(el.textContent) : null,
		value:
			el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
				? el.value
				: null,
		disabled: el
			? (el as HTMLButtonElement).disabled === true ||
				el.getAttribute("aria-disabled") === "true"
			: null,
		attributes: Object.fromEntries(
			(args.attributes ?? []).map((name) => [
				name,
				el ? el.getAttribute(name) : null,
			]),
		),
	};
}
