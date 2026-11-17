import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptySweepResult, type SweepProgress } from "@/lib/sweep-migration";
import {
	BSV20_UNCONFIRMED_REASON,
	BSV20_UNREADABLE_REASON,
} from "@/lib/wallet/migration-listings";
import {
	bsv20StaysLine,
	buildSweepSummary,
	buildWizardSteps,
	currentStepLine,
	formatBsv,
	formatTokenAmount,
	outcomeNotes,
	reviewLines,
	type SweepSummaryInput,
	shortError,
	staysCount,
	staysRows,
	summarizeOutcome,
	sweepScreenFor,
} from "@/lib/wallet/sweep-summary";

const op = (n: number) => ({ outpoint: `${String(n).padStart(64, "a")}_0` });
const ord = (n: number, name?: string) => ({
	...op(n),
	contentUrl: `https://example.test/${n}`,
	contentType: "image/png",
	name,
});

const empty: SweepSummaryInput = {
	funding: [],
	totalBsv: 0,
	ordinals: [],
	opnsNames: [],
	bsv21Tokens: [],
	bsv20Balances: [],
	listings: 0,
	bsv20Unsweepable: [],
	locked: [],
	run: [],
};

describe("formatTokenAmount", () => {
	it("places decimals, drops trailing zeros and groups digits", () => {
		assert.equal(formatTokenAmount(1234567n, 0), "1,234,567");
		assert.equal(formatTokenAmount(150000000n, 8), "1.5");
		assert.equal(formatTokenAmount("5", 3), "0.005");
		assert.equal(formatTokenAmount(0n, 4), "0");
		assert.equal(formatTokenAmount(123456789000n, 3), "123,456,789");
		assert.equal(formatTokenAmount(-2500n, 2), "-25");
	});
});

describe("formatBsv", () => {
	it("keeps every significant sat", () => {
		assert.equal(formatBsv(148_900_427), "1.48900427");
		assert.equal(formatBsv(100_000_000), "1");
		assert.equal(formatBsv(1), "0.00000001");
		assert.equal(formatBsv(1_234_500_000_000), "12,345");
	});
});

describe("buildSweepSummary", () => {
	it("reads BSV in BSV with sats beside it", () => {
		const s = buildSweepSummary({
			...empty,
			funding: [op(1), op(2)],
			totalBsv: 148_900_427,
		});
		assert.deepEqual(s.bsv, {
			sats: 148_900_427,
			bsv: "1.48900427",
			satsLabel: "148,900,427 sats",
			utxos: 2,
		});
		assert.equal(buildSweepSummary(empty).bsv, null);
	});

	it("caps ordinal thumbnails and counts the rest", () => {
		const s = buildSweepSummary({
			...empty,
			ordinals: Array.from({ length: 23 }, (_, i) => ord(i)),
		});
		assert.equal(s.ordinals.count, 23);
		assert.equal(s.ordinals.thumbs.length, 5);
		assert.equal(s.ordinals.more, 18);
		assert.equal(buildSweepSummary(empty).ordinals.more, 0);
	});

	it("previews two names and counts the rest", () => {
		const s = buildSweepSummary({
			...empty,
			opnsNames: [ord(1, "alice"), ord(2, "bob"), ord(3)],
		});
		assert.equal(s.names.count, 3);
		assert.deepEqual(s.names.preview, ["alice", "bob"]);
		assert.equal(s.names.more, 1);
	});

	it("gives one token line per ticker with its amount and output count", () => {
		const s = buildSweepSummary({
			...empty,
			bsv21Tokens: [
				{
					tokenId: `${"c".repeat(64)}_0`,
					decimals: 2,
					totalAmount: 12345n,
					outputs: [1, 2],
					isActive: true,
					icon: "https://example.test/icon",
				},
				{
					tokenId: `${"d".repeat(64)}_0`,
					symbol: "VIBES",
					decimals: 0,
					totalAmount: 7n,
					outputs: [1],
					isActive: false,
				},
			],
			bsv20Balances: [
				{
					tick: "PEPE",
					decimals: 0,
					totalAmount: 1000000n,
					outputs: [1, 2, 3],
				},
			],
		});
		assert.deepEqual(
			s.tokens.map((t) => [t.ticker, t.amount, t.outputCount, t.kind]),
			[
				["cccccccc", "123.45", 2, "bsv21"],
				["PEPE", "1,000,000", 3, "bsv20"],
			],
		);
		assert.equal(s.tokens[0].icon, "https://example.test/icon");
		// Inactive BSV-21 tokens move to "stays", never vanish.
		assert.deepEqual(
			s.inactiveTokens.map((t) => [t.ticker, t.outputCount]),
			[["VIBES", 1]],
		);
	});
});

const full = (): SweepSummaryInput => ({
	funding: [op(1)],
	totalBsv: 5000,
	ordinals: [ord(2)],
	opnsNames: [ord(3, "alice")],
	bsv21Tokens: [
		{
			tokenId: `${"c".repeat(64)}_0`,
			symbol: "GOLD",
			decimals: 0,
			totalAmount: 5n,
			outputs: [1],
			isActive: true,
		},
	],
	bsv20Balances: [],
	listings: 1,
	bsv20Unsweepable: [{ output: op(4), reason: BSV20_UNREADABLE_REASON }],
	locked: [],
	run: [],
});

describe("buildWizardSteps", () => {
	it("orders the steps and always ends with review", () => {
		assert.deepEqual(buildWizardSteps(buildSweepSummary(full())), [
			"bsv",
			"collectibles",
			"tokens",
			"stays",
			"review",
		]);
	});

	it("skips steps with nothing in them", () => {
		assert.deepEqual(buildWizardSteps(buildSweepSummary(empty)), ["review"]);
		assert.deepEqual(
			buildWizardSteps(
				buildSweepSummary({ ...empty, opnsNames: [ord(1, "a")] }),
			),
			["collectibles", "review"],
		);
		assert.deepEqual(
			buildWizardSteps(
				buildSweepSummary({
					...empty,
					funding: [op(1)],
					totalBsv: 0,
				}),
			),
			["review"],
		);
	});

	it("keeps a stays-only scan to stays and review", () => {
		assert.deepEqual(
			buildWizardSteps(buildSweepSummary({ ...empty, locked: [op(1)] })),
			["stays", "review"],
		);
		assert.deepEqual(
			buildWizardSteps(
				buildSweepSummary({
					...empty,
					bsv21Tokens: [
						{
							tokenId: "x",
							decimals: 0,
							totalAmount: 1n,
							outputs: [1],
							isActive: false,
						},
					],
				}),
			),
			["stays", "review"],
		);
	});

	it("maps every host phase to one screen", () => {
		assert.equal(sweepScreenFor("scan"), "scan");
		assert.equal(sweepScreenFor("intro"), "scan");
		assert.equal(sweepScreenFor("preview"), "steps");
		assert.equal(sweepScreenFor("migrate"), "progress");
		assert.equal(sweepScreenFor("complete"), "done");
		assert.equal(sweepScreenFor("error"), "error");
	});
});

describe("staysRows", () => {
	it("merges both BSV-20 reasons into one group and keeps a row per other reason", () => {
		const summary = buildSweepSummary({
			...empty,
			bsv20Unsweepable: [
				{ output: op(1), reason: BSV20_UNREADABLE_REASON },
				{ output: op(2), reason: BSV20_UNREADABLE_REASON },
				{ output: op(3), reason: BSV20_UNCONFIRMED_REASON },
			],
			bsv21Tokens: [
				{
					tokenId: "t",
					symbol: "VIBES",
					decimals: 0,
					totalAmount: 1n,
					outputs: [1, 2],
					isActive: false,
				},
			],
			locked: [op(4)],
			run: [op(5), op(6)],
			listings: 2,
		});
		const rows = staysRows(summary);
		assert.deepEqual(
			rows.map((r) => [r.kind, r.label, r.count]),
			[
				["bsv20", "BSV-20 inscriptions", 3],
				["inactive", "VIBES: not validated on the overlay, skipped.", 2],
				["locked", "1 time-locked output: sweep them after they unlock.", 1],
				[
					"run",
					"2 RUN outputs: kept out of the BSV sweep so their token state isn't spent as fees.",
					2,
				],
				["listings", "2 listings are cancelled, then the ordinals move.", 2],
			],
		);
		assert.equal(rows[0].outpoints.length, 3);
		// Screen lines never carry an outpoint.
		for (const r of rows) assert.doesNotMatch(r.label, /aaaa/);
		// Listings are not "staying behind".
		assert.equal(staysCount(summary), 3 + 2 + 1 + 2);
	});

	it("says BSV-20 inscriptions are still yours", () => {
		assert.equal(
			bsv20StaysLine(3),
			"3 BSV-20 inscriptions stay at your old address (still yours)",
		);
		assert.equal(bsv20StaysLine(0), null);
		assert.equal(BSV20_UNREADABLE_REASON, "not confirmed by the indexer");
	});
});

describe("reviewLines", () => {
	it("lists only included classes, each pointing at its step", () => {
		const summary = buildSweepSummary(full());
		const all = new Set([
			"listings",
			"ordinals",
			"bsv21",
			"bsv20",
			"bsv",
		] as const);
		assert.deepEqual(
			reviewLines(summary, all, 1).map((l) => [l.step, l.label, l.value]),
			[
				["bsv", "BSV", "0.00005 BSV"],
				["collectibles", "Collectibles", "1 ordinal · 1 name"],
				["tokens", "Tokens", "5 GOLD"],
				["stays", "Listings", "Cancel 1"],
			],
		);
		assert.deepEqual(
			reviewLines(summary, new Set(["bsv"] as const), 1).map((l) => l.step),
			["bsv"],
		);
	});
});

const step = (
	id: string,
	label: string,
	status: "pending" | "active" | "done" | "error",
	extra: { detail?: string; txids?: string[]; error?: string } = {},
) => ({ id, label, status, txids: [], ...extra });

describe("currentStepLine", () => {
	it("uses the stage message before the sweep reports steps", () => {
		assert.equal(
			currentStepLine(null, "Deriving identity key..."),
			"Deriving identity key...",
		);
	});

	it("names the active step, its place and its batch", () => {
		const progress: SweepProgress = {
			message: "Ordinal sweep: broadcasting (batch 2/5)...",
			percent: 40,
			steps: [
				step("bsv", "BSV funding (3 UTXOs)", "done"),
				step("ordinals", "Ordinals (230)", "active", {
					detail: "broadcasting (batch 2/5)",
				}),
				step("bsv20:PEPE", "PEPE (3 outputs)", "pending"),
				step("token:x", "VIBES (1 output)", "pending"),
				step("token:y", "GOLD (2 outputs)", "pending"),
			],
		};
		assert.equal(
			currentStepLine(progress, ""),
			"Step 2 of 5: Moving ordinals (batch 2/5)",
		);
		progress.steps[1].status = "done";
		progress.steps[2].status = "active";
		progress.steps[2].detail = "fetching source txs 1/3";
		assert.equal(currentStepLine(progress, ""), "Step 3 of 5: Moving PEPE");
		for (const s of progress.steps) s.status = "done";
		assert.equal(currentStepLine(progress, ""), "Finishing up");
	});
});

describe("summarizeOutcome", () => {
	it("says nothing was there when no sweep ran", () => {
		const o = summarizeOutcome(null, 0);
		assert.equal(o.kind, "nothing");
		assert.equal(o.headline, "Nothing to sweep");
	});

	it("reads all moved from the result's txids", () => {
		const o = summarizeOutcome(
			emptySweepResult({
				bsvTxids: ["a"],
				ordinalTxids: ["b", "c"],
				cancelTxids: ["d"],
				cancelledListings: ["e"],
			}),
			0,
		);
		assert.equal(o.kind, "all-moved");
		assert.equal(o.headline, "All moved");
		assert.deepEqual(
			o.rows.map((r) => [r.label, r.note]),
			[
				["BSV", "Moved"],
				["Ordinals & names", "Moved"],
				["Listings", "2 listings cancelled"],
			],
		);
	});

	it("marks each step from the sweep's own status and counts what is left", () => {
		const o = summarizeOutcome(
			emptySweepResult({ bsvTxids: ["a"], errors: ["Ordinal sweep: boom"] }),
			4,
			[
				step("bsv", "BSV funding (1 UTXO)", "done", { txids: ["a"] }),
				step("ordinals", "Ordinals (9)", "error", {
					txids: ["b"],
					error: "1 of 2 batches failed",
				}),
				step("bsv20:PEPE", "PEPE (3 outputs)", "error", {
					error: "1 of 1 batch failed",
				}),
			],
		);
		assert.equal(o.kind, "moved-with-left");
		assert.equal(o.headline, "Moved, 4 left");
		assert.deepEqual(
			o.rows.map((r) => [r.label, r.status]),
			[
				["BSV", "done"],
				["Ordinals & names", "partial"],
				["PEPE", "failed"],
			],
		);
		assert.equal(o.errorCount, 1);
	});

	it("says nothing moved when every step failed", () => {
		const o = summarizeOutcome(emptySweepResult({ errors: ["x"] }), 3, [
			step("bsv", "BSV funding (1 UTXO)", "error", {
				error: "1 of 1 batch failed",
			}),
		]);
		assert.equal(o.kind, "failed");
	});
});

describe("outcomeNotes", () => {
	it("turns sweep errors into plain reasons, once each", () => {
		assert.deepEqual(
			outcomeNotes([
				"Token GOLD (batch 1/2): 2 outputs were not accepted by the token overlay and stayed at the legacy address (x_0, y_0)",
				"Token GOLD (batch 2/2): 1 output was not accepted by the token overlay and stayed at the legacy address (z_0)",
				"Ordinal sweep: skipped abc_0 (404)",
				"Legacy ord key could not be read (bad wif); outputs at its address were not swept.",
				"something new",
			]),
			[
				"Some token outputs weren't accepted by the token overlay and stayed put.",
				"Some source transactions couldn't be fetched, so those items stayed put.",
				"An old key couldn't be read, so items at its address stayed put.",
				"Some transactions failed. See Details.",
			],
		);
	});
});

describe("shortError", () => {
	it("maps known errors to short copy", () => {
		assert.equal(
			shortError(
				"Failed to re-encrypt wallet. Try unlocking your wallet again first.",
			),
			"Couldn't save your wallet. Unlock it again and retry.",
		);
		assert.equal(
			shortError(
				"Listings must be cancelled before migration can finish. 1 of 2 not cancelled: timeout.",
			),
			"Some listings couldn't be cancelled.",
		);
		assert.equal(
			shortError("TypeError: Failed to fetch"),
			"Network problem. Check your connection and try again.",
		);
	});

	it("keeps the first sentence of an unknown error, capped", () => {
		assert.equal(
			shortError("Bad thing happened. More detail here."),
			"Bad thing happened.",
		);
		const long = shortError("x".repeat(400));
		assert.ok(long.length <= 140);
		assert.equal(shortError("   "), "Something went wrong.");
	});
});
