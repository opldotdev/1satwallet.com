import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	canSubmitPaths,
	detectionResultApplies,
	nextSearchRun,
	type PathSearchNow,
	searchOwnsProcessing,
	supersedeSearch,
	type WalletPaths,
} from "../lib/wallet/mnemonic-paths";

// Placeholder phrases: these tests compare strings, never derive keys.
const PHRASE_A = "phrase-a";
const PHRASE_B = "phrase-b";
const DETECTED: WalletPaths = {
	changeAddressPath: "m/0",
	ordAddressPath: "m/0/7",
};

/**
 * The grid's search bookkeeping, driven the way the component drives it:
 * the latest run number plus the words and switch on screen.
 */
function grid(phrase: string) {
	const now: PathSearchNow = {
		latestRunId: 0,
		phrase,
		useCustomPaths: false,
	};
	return {
		now,
		search() {
			const run = nextSearchRun(now.latestRunId, now.phrase);
			now.latestRunId = run.id;
			return run;
		},
		edit(phrase: string) {
			now.phrase = phrase;
		},
		startOver() {
			now.latestRunId = supersedeSearch(now.latestRunId);
			now.phrase = "";
		},
		customOn() {
			now.latestRunId = supersedeSearch(now.latestRunId);
			now.useCustomPaths = true;
		},
	};
}

describe("a path search that returns", () => {
	it("applies and clears the spinner while nothing changed", () => {
		const g = grid(PHRASE_A);
		const run = g.search();
		assert.equal(searchOwnsProcessing(run, g.now), true);
		assert.equal(detectionResultApplies(run, g.now), true);
	});

	it("after the words were edited mid-search, clears the spinner but drops its result", () => {
		const g = grid(PHRASE_A);
		const run = g.search();
		g.edit(PHRASE_B);
		// Clearing the spinner lets the search run again for the new words.
		assert.equal(searchOwnsProcessing(run, g.now), true);
		assert.equal(detectionResultApplies(run, g.now), false);
	});

	it("after Start over, leaves the spinner and the paths alone", () => {
		const g = grid(PHRASE_A);
		const run = g.search();
		g.startOver();
		assert.equal(searchOwnsProcessing(run, g.now), false);
		assert.equal(detectionResultApplies(run, g.now), false);
	});

	it("after Start over and a new phrase, leaves the new search's spinner on", () => {
		const g = grid(PHRASE_A);
		const old = g.search();
		g.startOver();
		g.edit(PHRASE_B);
		const current = g.search();
		// The old search returns first: it must not end the new one's
		// spinner, or the grid would start a duplicate search.
		assert.equal(searchOwnsProcessing(old, g.now), false);
		assert.equal(detectionResultApplies(old, g.now), false);
		assert.equal(searchOwnsProcessing(current, g.now), true);
		assert.equal(detectionResultApplies(current, g.now), true);
	});

	it("drops its result even when the same words are pasted back after Start over", () => {
		const g = grid(PHRASE_A);
		const old = g.search();
		g.startOver();
		g.edit(PHRASE_A);
		g.search();
		assert.equal(detectionResultApplies(old, g.now), false);
	});

	it("after custom paths were switched on, leaves the spinner and the paths alone", () => {
		const g = grid(PHRASE_A);
		const run = g.search();
		g.customOn();
		assert.equal(searchOwnsProcessing(run, g.now), false);
		assert.equal(detectionResultApplies(run, g.now), false);
	});

	it("never applies in custom mode, even as the latest run", () => {
		const run = nextSearchRun(0, PHRASE_A);
		assert.equal(
			detectionResultApplies(run, {
				latestRunId: run.id,
				phrase: PHRASE_A,
				useCustomPaths: true,
			}),
			false,
		);
	});
});

describe("Next", () => {
	const ready = { isValid: true, processing: false };

	it("imports with a valid phrase and both paths", () => {
		assert.equal(canSubmitPaths({ ...ready, paths: DETECTED }), true);
	});

	it("waits while no path is known, even in custom mode", () => {
		assert.equal(canSubmitPaths({ ...ready, paths: undefined }), false);
	});

	it("waits until both custom paths are filled in", () => {
		for (const paths of [
			{ changeAddressPath: "m/0", ordAddressPath: "" },
			{ changeAddressPath: " ", ordAddressPath: "m/0/0" },
		]) {
			assert.equal(canSubmitPaths({ ...ready, paths }), false);
		}
	});

	it("waits for a valid phrase and for the search to finish", () => {
		assert.equal(
			canSubmitPaths({ isValid: false, processing: false, paths: DETECTED }),
			false,
		);
		assert.equal(
			canSubmitPaths({ isValid: true, processing: true, paths: DETECTED }),
			false,
		);
	});
});
