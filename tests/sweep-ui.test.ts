import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const SWEEP_DIR = "components/wallet/sweep";
const sweepFiles = readdirSync(join(process.cwd(), SWEEP_DIR)).filter((f) =>
	f.endsWith(".tsx"),
);
const page = read("app/(main)/wallet/migrate/page.tsx");
const wizard = read("components/wallet/migration-wizard.tsx");
const flow = read("components/wallet/migration-sections.tsx");

describe("sweep wizard wiring", () => {
	it("both hosts render the one shared flow", () => {
		for (const host of [page, wizard]) {
			assert.match(host, /<MigrationSweepFlow/);
			assert.match(host, /sweepScreenFor\(/);
		}
	});

	it("the flow is the wizard frame and the five steps", () => {
		for (const name of [
			"SweepWizard",
			"SweepStepBsv",
			"SweepStepCollectibles",
			"SweepStepTokens",
			"SweepStepStays",
			"SweepStepReview",
		]) {
			assert.match(flow, new RegExp(`<${name}\\b`), name);
		}
	});

	it("keeps the scan gate, rescan, selection and delist-only", () => {
		assert.match(page, /decideScanPhase\(/);
		assert.match(page, /countSweepableLegacyAssets\(assets\)/);
		assert.match(page, /assets\.rescan\(\)/);
		assert.match(flow, /Cancel listings only/);
		for (const host of [page, wizard]) {
			assert.match(host, /selectedTypes=\{selectedTypes\}/);
			assert.match(host, /console\.error\(/);
			assert.match(host, /onCancelListingsOnly=/);
		}
	});

	it("keeps a deliberate deselect-all", () => {
		for (const host of [page, wizard]) {
			assert.doesNotMatch(host, /selectedOrdinals\.size === 0/);
			assert.match(host, /useDefaultOrdinalSelection\(unlistedOrdinals\)/);
		}
		// The scanned lists keep their identity between renders.
		const assets = read("lib/hooks/use-legacy-assets.ts");
		assert.doesNotMatch(assets, /\?\? \[\]\)\.map\(enrichOrdinal\)/);
		assert.match(assets, /const lists = useMemo\(/);
	});
});

describe("sweep components", () => {
	const src = (f: string) => read(`${SWEEP_DIR}/${f}`);

	it("are presentational: nothing from providers or hooks into lib", () => {
		assert.ok(sweepFiles.length >= 10);
		for (const f of sweepFiles) {
			assert.doesNotMatch(src(f), /@\/providers\/|@\/lib\/hooks\//, f);
		}
		assert.doesNotMatch(flow, /@\/providers\/|@\/lib\/hooks\//);
	});

	it("show txids and outpoints only in the Details sheet", () => {
		for (const f of sweepFiles.filter((f) => f !== "sweep-details.tsx")) {
			// An outpoint may key a row; it is never rendered as text.
			assert.doesNotMatch(src(f), /txid/i, f);
			assert.doesNotMatch(src(f), />\s*\{[\w.]*outpoints?\}/, f);
		}
		for (const host of [page, wizard, flow]) {
			assert.doesNotMatch(host, /SweepResultRows|SweepStepsList|TypeChecklist/);
		}
	});

	it("pin the footer clear of the home indicator", () => {
		const shell = src("sweep-shell.tsx");
		assert.match(shell, /sticky bottom-0/);
		assert.match(shell, /env\(safe-area-inset-bottom\)/);
	});

	it("guard every motion for reduced-motion users", () => {
		for (const f of sweepFiles) {
			const s = src(f);
			assert.doesNotMatch(
				s,
				/(?<!motion-safe:)\b(animate-in|animate-spin|animate-pulse|slide-in-from|transition-(all|opacity|transform|\[width\]))/,
				f,
			);
		}
		const css = src("sweep-route-diagram.module.css");
		assert.match(css, /prefers-reduced-motion: no-preference/);
		const pkg = read("package.json");
		assert.doesNotMatch(pkg, /"(framer-motion|motion)"/);
	});

	it("say what stays put plainly, BSV-20 amounts only as claims", () => {
		const stays = src("sweep-step-stays.tsx") + src("sweep-bsv20-stays.tsx");
		assert.match(flow, /Still yours/);
		assert.match(stays, /claimed/);
		assert.match(src("sweep-details.tsx"), /claimed/);
	});
});

describe("BSV-20 content labels stay out of the sweep", () => {
	it("no sweep, plan or scan file reads them", () => {
		for (const f of [
			"lib/sweep-migration.ts",
			"lib/wallet/migration-listings.ts",
			"lib/hooks/use-legacy-assets.ts",
			"lib/wallet/legacy-scan-state.ts",
		]) {
			assert.doesNotMatch(read(f), /bsv20-content|use-bsv20-content/, f);
		}
	});

	it("never reach executeMigrationSweep", () => {
		for (const host of [page, wizard]) {
			const calls = host.match(/executeMigrationSweep\(\{[\s\S]*?\}\);/g) ?? [];
			assert.ok(calls.length > 0);
			for (const call of calls) assert.doesNotMatch(call, /bsv20Display/);
		}
	});

	it("fetches with a cap, bounded concurrency and an abort", () => {
		const hook = read("lib/hooks/use-bsv20-content.ts");
		assert.match(hook, /max = 200/);
		assert.match(hook, /concurrency = 6/);
		assert.match(hook, /new AbortController\(\)/);
		assert.match(hook, /controller\.abort\(\)/);
		assert.match(hook, /BSV20_CONTENT_MAX_BYTES/);
		// The cap holds without a Content-Length, and the cache is bounded.
		assert.match(hook, /getReader\(\)/);
		assert.match(hook, /reader\.cancel\(\)/);
		assert.match(hook, /CACHE_MAX_ENTRIES = 1000/);
		// Fetches restart only when the outpoints change, not the array.
		assert.match(hook, /\[enabled, wanted, concurrency\]/);
		assert.match(hook, /\[wantedKey\]/);
	});

	it("leaves no 'no readable ticker' copy on screen", () => {
		const dirs = ["components", "app"];
		const walk = (dir: string): string[] =>
			readdirSync(join(process.cwd(), dir), { withFileTypes: true }).flatMap(
				(e) =>
					e.isDirectory()
						? walk(`${dir}/${e.name}`)
						: /\.tsx?$/.test(e.name)
							? [`${dir}/${e.name}`]
							: [],
			);
		for (const file of dirs.flatMap(walk)) {
			assert.doesNotMatch(read(file), /no readable ticker/i, file);
		}
	});
});
