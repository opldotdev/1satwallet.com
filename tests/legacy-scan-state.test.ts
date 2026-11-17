import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	countSweepableLegacyAssets,
	decideScanPhase,
	legacyAddressKey,
} from "@/lib/wallet/legacy-scan-state";

const out = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

const migratedWithKeys = {
	hasLegacyKeys: true,
	migrated: true,
	scanned: true,
	loading: false,
	balanceLoading: false,
	sweepable: 0,
	listings: 0,
};

describe("migration page scan gate", () => {
	it("waits while the scan of the legacy addresses has not finished", () => {
		// The live bug: a migrated wallet read "Already Migrated" on the first
		// render, before its legacy scan had started, while the sidebar banner
		// later counted 22 items.
		assert.equal(
			decideScanPhase({ ...migratedWithKeys, scanned: false }),
			"wait",
		);
		assert.equal(
			decideScanPhase({ ...migratedWithKeys, loading: true }),
			"wait",
		);
		assert.equal(
			decideScanPhase({ ...migratedWithKeys, balanceLoading: true }),
			"wait",
		);
	});

	it("offers the sweep again when a migrated wallet still has legacy assets", () => {
		assert.equal(
			decideScanPhase({ ...migratedWithKeys, sweepable: 22 }),
			"preview",
		);
		assert.equal(
			decideScanPhase({ ...migratedWithKeys, listings: 1 }),
			"preview",
		);
	});

	it("says nothing is left only after a finished scan found nothing", () => {
		assert.equal(decideScanPhase(migratedWithKeys), "nothing-to-sweep");
	});

	it("keeps the legacy first-run path and its missing-key error", () => {
		assert.equal(
			decideScanPhase({ ...migratedWithKeys, migrated: false, sweepable: 3 }),
			"preview",
		);
		assert.equal(
			decideScanPhase({
				...migratedWithKeys,
				hasLegacyKeys: false,
				migrated: false,
			}),
			"missing-keys",
		);
	});
});

describe("sweepable legacy count", () => {
	it("counts BSV, ordinals, OpNS names and every token output", () => {
		assert.equal(
			countSweepableLegacyAssets({
				funding: out(2),
				ordinals: out(9),
				opnsNames: out(1),
				bsv21Tokens: [{ outputs: out(4) }, { outputs: out(3) }],
				bsv20Balances: [{ outputs: out(3) }],
			}),
			22,
		);
	});

	it("is the one count the banner and the migration page use", () => {
		const banner = readFileSync(
			join(import.meta.dirname, "../components/wallet/legacy-sweep-banner.tsx"),
			"utf8",
		);
		const page = readFileSync(
			join(import.meta.dirname, "../app/(main)/wallet/migrate/page.tsx"),
			"utf8",
		);
		assert.match(banner, /countSweepableLegacyAssets\(/);
		assert.match(page, /countSweepableLegacyAssets\(assets\)/);
		assert.match(page, /decideScanPhase\(/);
		assert.doesNotMatch(page, /Already Migrated/);
	});
});

describe("legacy address key", () => {
	it("ignores order, duplicates and missing addresses", () => {
		assert.equal(legacyAddressKey(["b", null, "a", "b"]), "a,b");
		assert.equal(legacyAddressKey([null, undefined, ""]), null);
	});

	it("marks the scan unfinished until a result exists for these addresses", () => {
		const hook = readFileSync(
			join(import.meta.dirname, "../lib/hooks/use-legacy-assets.ts"),
			"utf8",
		);
		assert.match(
			hook,
			/loading: loading \|\| \(addressKey !== null && !scanned\)/,
		);
	});
});
