import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	MigrationSweepFlow,
	type MigrationSweepFlowProps,
} from "../components/wallet/migration-sections";
import { emptySweepResult } from "../lib/sweep-migration";
import { BSV20_UNREADABLE_REASON } from "../lib/wallet/migration-listings";
import { buildSweepSummary } from "../lib/wallet/sweep-summary";

const outpoint = (n: number) => `${String(n).padStart(64, "f")}_0`;
const ordinals = Array.from({ length: 23 }, (_, i) => ({
	outpoint: outpoint(i),
	contentUrl: `https://example.test/${i}`,
	contentType: "image/png",
}));
const summary = buildSweepSummary({
	funding: [{}, {}],
	totalBsv: 148_900_427,
	ordinals,
	opnsNames: [],
	bsv21Tokens: [],
	bsv20Balances: [
		{ tick: "PEPE", decimals: 0, totalAmount: 1_000_000n, outputs: [1, 2] },
	],
	listings: 0,
	bsv20Unsweepable: Array.from({ length: 150 }, (_, i) => ({
		output: { outpoint: outpoint(100 + i) },
		reason: BSV20_UNREADABLE_REASON,
	})),
	locked: [],
	run: [],
});

const noop = () => {};
const base: MigrationSweepFlowProps = {
	variant: "page",
	screen: "steps",
	firstRun: false,
	canSweep: true,
	scanDetail: null,
	scanError: null,
	onRetryScan: noop,
	summary,
	ordinals,
	selectedOrdinals: new Set(ordinals.map((o) => o.outpoint)),
	onToggleOrdinal: noop,
	onSelectAllOrdinals: noop,
	onDeselectAllOrdinals: noop,
	selectedTypes: new Set(["listings", "ordinals", "bsv21", "bsv20", "bsv"]),
	onToggleType: noop,
	plannedTotal: 27,
	onSweep: noop,
	onCancelListingsOnly: noop,
	progressMessage: "Deriving identity key...",
	progressPercent: 40,
	sweepProgress: null,
	sweepResult: null,
	remaining: 0,
	doneLabel: (n) => `Sweep Remaining ${n}`,
	onDone: noop,
	error: null,
	onTryAgain: noop,
	addresses: [],
	destination: "This wallet",
	bsv20: { groups: [], total: 150, checked: 0, loading: false },
};
const render = (props: Partial<MigrationSweepFlowProps> = {}) =>
	renderToStaticMarkup(<MigrationSweepFlow {...base} {...props} />);

describe("sweep wizard screens", () => {
	it("opens on the BSV step with the amount, the route and Next", () => {
		const html = render();
		assert.match(html, /Step 1 of 5/);
		assert.match(html, /Move your BSV/);
		assert.match(html, /1\.48900427/);
		assert.match(html, /148,900,427 sats/);
		assert.match(html, /Old addresses/);
		assert.match(html, /This wallet/);
		assert.match(html, />Next</);
		assert.match(html, /env\(safe-area-inset-bottom\)/);
		// No outpoint anywhere on screen.
		assert.doesNotMatch(html, /ffffffff/);
	});

	it("shows one line while sweeping, never a log", () => {
		const html = render({ screen: "progress" });
		assert.match(html, /Moving your assets/);
		assert.match(html, /Deriving identity key/);
		assert.match(html, /Sweeping…/);
		assert.doesNotMatch(html, /ffffffff/);
	});

	it("says what is left and keeps the rescan label", () => {
		const html = render({
			screen: "done",
			sweepResult: emptySweepResult({ bsvTxids: ["a".repeat(64)] }),
			remaining: 3,
		});
		assert.match(html, /Moved, 3 left/);
		assert.match(html, /Sweep Remaining 3/);
		assert.match(
			html,
			/150 BSV-20 inscriptions stay at your old address \(still yours\)/,
		);
		assert.doesNotMatch(html, /aaaaaaaa/);
	});

	it("shows a short error, never the raw text", () => {
		const raw =
			"Failed to re-encrypt wallet. Try unlocking your wallet again first. stack: at x (y.ts:1)";
		const html = render({ screen: "error", error: raw });
		assert.match(html, /Couldn&#x27;t save your wallet/);
		assert.doesNotMatch(html, /stack: at x/);
		assert.match(html, /Try again/);
	});

	it("checks the old addresses first", () => {
		const html = render({ screen: "scan", scanDetail: "Scanning pay address" });
		assert.match(html, /Checking your old addresses/);
		assert.match(html, /Scanning pay address/);
		assert.match(html, /Scanning…/);
	});
});
