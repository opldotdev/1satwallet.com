import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buttonVariants } from "../components/ui/button";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const css = read("components/wallet/wallet-home.module.css");
const home = read("components/wallet/wallet-home.tsx");
const actions = read("components/wallet/wallet-home-actions.tsx");
const locks = read("components/wallet/wallet-locks.tsx");
const unlock = read("components/wallet/full-screen-unlock.tsx");

/** The rules inside `@media (max-width: 767px) { ... }`. */
function phoneRules(source: string) {
	const start = source.indexOf("@media (max-width: 767px)");
	assert.ok(start >= 0, "phone media query");
	let depth = 0;
	for (let i = source.indexOf("{", start); i < source.length; i++) {
		if (source[i] === "{") depth++;
		if (source[i] === "}" && --depth === 0) return source.slice(start, i);
	}
	throw new Error("unclosed phone media query");
}

describe("wallet overview on phones", () => {
	const phone = phoneRules(css);

	it("drops the hero's height and the radar, and sets a 34px balance", () => {
		assert.match(phone, /\.hero \{[^}]*min-height: 0;/);
		assert.match(phone, /\.radar \{\s*display: none;/);
		assert.match(phone, /\.amount \{[^}]*font-size: 34px;/);
		assert.match(phone, /\.amount \{[^}]*letter-spacing: -0\.03em;/);
	});

	it("uses a 12px eyebrow and 56px rows on a 24px | 1fr | auto grid", () => {
		assert.match(
			css,
			/\.eyebrow \{[^}]*font-size: 12px;[^}]*letter-spacing: 0\.08em;/,
		);
		assert.match(
			css,
			/\.assetRow,\s*\.activity,\s*\.serviceRow \{[^}]*grid-template-columns: 24px minmax\(0, 1fr\) auto;[^}]*min-height: 56px;[^}]*padding: 12px 0;/,
		);
	});

	it("keeps spacing on the 4/8/12/16/24/32 scale and type at 12px or more", () => {
		const scale = new Set([0, 4, 8, 12, 16, 24, 32]);
		for (const [, prop, value] of css.matchAll(
			/\b(gap|row-gap|column-gap|padding(?:-\w+)?|margin(?:-\w+)?):\s*([^;]+);/g,
		)) {
			for (const px of value.matchAll(/(-?\d+)px/g)) {
				assert.ok(scale.has(Math.abs(Number(px[1]))), `${prop}: ${value}`);
			}
		}
		for (const [, size] of css.matchAll(/font-size: (\d+)px/g)) {
			assert.ok(Number(size) >= 12, `font-size ${size}px`);
		}
	});

	it("puts the Send and Receive tiles in a Button variant, not module CSS", () => {
		assert.match(buttonVariants({ variant: "tile" }), /bg-muted/);
		assert.equal(actions.match(/variant="tile"/g)?.length, 2);
		assert.equal(actions.match(/size="lg"/g)?.length, 3);
		assert.doesNotMatch(css, /\.action\b/);
	});

	it("uses the shared notices, review list and sheet footers", () => {
		assert.match(
			home,
			/<Notice title="Wallet data could not be refreshed" tone="danger">/,
		);
		assert.match(home, /Your connected wallet doesn't share its balance\./);
		assert.match(home, /<EmptyState[\s\S]*title="Wallet locked"/);
		for (const source of [actions, locks]) {
			assert.match(source, /<DetailList>/);
			assert.match(source, /<DialogFooter>/);
			assert.match(source, /<Notice tone="danger">/);
		}
		assert.match(locks, /<SectionHeader/);
		assert.match(locks, /<Notice tone="warning">/);
	});

	it("leaves no off-scale radius, tiny type or padding overrides on sheets", () => {
		for (const [file, source] of [
			["wallet-home.tsx", home],
			["wallet-home-actions.tsx", actions],
			["wallet-locks.tsx", locks],
			["full-screen-unlock.tsx", unlock],
		] as const) {
			assert.doesNotMatch(source, /rounded-(2xl|3xl)|text-\[1[01]px\]/, file);
			assert.doesNotMatch(source, /\brounded(?=[\s"])/, file);
			for (const tag of source.match(/<DialogContent[\s\S]*?>/g) ?? []) {
				assert.doesNotMatch(tag, /[\s"]p-\d|[\s"]gap-\d/, file);
			}
		}
	});

	it("shows locks loading as skeleton rows with a status", () => {
		const loading = locks.slice(
			locks.indexOf("locksQuery.isPending ?"),
			locks.indexOf("locksQuery.isError ?"),
		);
		assert.match(loading, /role="status"/);
		assert.match(loading, /sr-only">Loading locks…/);
		assert.match(loading, /<Skeleton/);
		assert.doesNotMatch(loading, /Loader2/);
	});
});

describe("unlock screen", () => {
	it("is a bottom sheet on phones and a centered card from sm", () => {
		assert.match(unlock, /h-dvh items-end justify-center/);
		assert.match(unlock, /sm:items-center/);
		assert.match(
			unlock,
			/max-sm:pb-\[max\(var\(--card-spacing\),env\(safe-area-inset-bottom\)\)\]/,
		);
		assert.match(unlock, /sm:max-w-md/);
	});

	it("shows its label and uses a large submit button", () => {
		assert.match(unlock, /<Label htmlFor="passphrase">Passphrase<\/Label>/);
		assert.match(unlock, /size="lg"\s+type="submit"/);
		assert.match(unlock, /role="alert"/);
	});
});
