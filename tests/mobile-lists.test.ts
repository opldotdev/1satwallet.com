import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

const LIST_FILES = [
	"components/wallet/ordinals-grid.tsx",
	"components/wallet/ordinals-grid-skeleton.tsx",
	"components/wallet/ordinal-action-dialog.tsx",
	"components/wallet/history-list.tsx",
	"components/wallet/incoming-payments.tsx",
	"components/opns/owned-opns.tsx",
];

describe("wallet lists on phones", () => {
	it("use the shared type scale, radius and headers", () => {
		for (const file of LIST_FILES) {
			const source = read(file);
			assert.doesNotMatch(source, /text-\[1[01]px\]/, file);
			// Chips are rounded-full, cards rounded-xl; no bare 4px radius.
			assert.doesNotMatch(source, /[\s"`]rounded[\s"`]/, file);
			assert.doesNotMatch(source, /font-mono text-xl/, file);
		}
		for (const file of [
			"components/wallet/ordinals-grid.tsx",
			"components/wallet/history-list.tsx",
			"components/wallet/incoming-payments.tsx",
			"components/opns/owned-opns.tsx",
		]) {
			assert.match(read(file), /<SectionHeader/, file);
		}
	});

	it("show ordinal actions only in the bar, and only with a selection", () => {
		const grid = read("components/wallet/ordinals-grid.tsx");
		assert.match(grid, /\{selectedOutpoints\.size > 0 && \(/);
		assert.match(grid, /aria-label="Selected ordinals"/);
		// The bar is the only place the actions open from.
		assert.equal(grid.match(/setDialogKind\("send"\)/g)?.length, 1);
		assert.equal(grid.match(/setDialogKind\("burn"\)/g)?.length, 1);
		assert.equal(grid.match(/setDialogKind\("cancel"\)/g)?.length, 1);
		// No permanent market notice above the grid.
		assert.doesNotMatch(grid, /LISTING_CREATE_OFF_MESSAGE/);
		// A 44px tap target around the selection checkbox.
		assert.match(grid, /<label className="[^"]*\bsize-11\b/);
		// Fixed to the screen bottom on phones, a floating card from md, with
		// the page gutter at every width.
		assert.match(
			grid,
			/"fixed inset-x-0 bottom-0 [^"]*md:sticky[^"]*md:px-\(--page-x\)/,
		);
		assert.doesNotMatch(grid, /md:px-4/);
		assert.match(grid, /aria-live="polite"/);
		assert.match(grid, /gridRef\.current\?\.focus\(\)/);
	});

	it("show the whole outpoint in the review before a send or burn", () => {
		const dialog = read("components/wallet/ordinal-action-dialog.tsx");
		assert.doesNotMatch(dialog, /shortOutpoint/);
		assert.match(dialog, /burn: "Permanently burn ordinals"/);
	});

	it("give history rows a short txid and one status badge", () => {
		const history = read("components/wallet/history-list.tsx");
		assert.match(history, /shortTxid\(action\.txid\)/);
		assert.match(history, /actionStatusLabel\(action\)/);
		assert.equal(history.match(/<Badge/g)?.length, 1);
		assert.doesNotMatch(history, /Loader2/);
		assert.match(history, /<Skeleton/);
	});
});
