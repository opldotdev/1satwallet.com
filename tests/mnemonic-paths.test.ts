import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	canSubmitPaths,
	detectionResultApplies,
	pathsAfterCustomToggle,
	type WalletPaths,
} from "../lib/wallet/mnemonic-paths";

// Placeholder phrases: these tests compare strings, never derive keys.
const PHRASE_A = "phrase-a";
const PHRASE_B = "phrase-b";
const DETECTED: WalletPaths = {
	changeAddressPath: "m/0",
	ordAddressPath: "m/0/7",
};
const RELAYX: WalletPaths = {
	changeAddressPath: "m/44'/236'/0'/0/0",
	ordAddressPath: "m/44'/236'/1'/0/0",
	identityAddressPath: "m/0'/236'/0'/0/0",
};

describe("a path search that returns", () => {
	it("applies to the words it searched while they are unchanged", () => {
		assert.equal(
			detectionResultApplies(PHRASE_A, {
				phrase: PHRASE_A,
				useCustomPaths: false,
			}),
			true,
		);
	});

	it("is ignored once the words were edited to another phrase mid-search", () => {
		assert.equal(
			detectionResultApplies(PHRASE_A, {
				phrase: PHRASE_B,
				useCustomPaths: false,
			}),
			false,
		);
	});

	it("is ignored once the words were cleared with Start over", () => {
		assert.equal(
			detectionResultApplies(PHRASE_A, { phrase: "", useCustomPaths: false }),
			false,
		);
	});

	it("is ignored once custom paths were switched on mid-search", () => {
		assert.equal(
			detectionResultApplies(PHRASE_A, {
				phrase: PHRASE_A,
				useCustomPaths: true,
			}),
			false,
		);
	});
});

describe("the custom paths switch", () => {
	it("clears a preset when turned off, so the search runs again", () => {
		assert.equal(pathsAfterCustomToggle(false, RELAYX), undefined);
	});

	it("keeps the found paths as a starting point when turned on", () => {
		assert.deepEqual(pathsAfterCustomToggle(true, DETECTED), DETECTED);
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
