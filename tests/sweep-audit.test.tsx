import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TokenBalance } from "@1sat/actions";
import type { IndexedOutput } from "@1sat/types";
import { PrivateKey, type WalletInterface } from "@bsv/sdk";
import { IDBFactory } from "fake-indexeddb";
import { renderToStaticMarkup } from "react-dom/server";
import { SweepAuditView } from "../components/wallet/sweep-audit-view";
import { auditPlanFromScan, SKIPPED_BY_USER } from "../lib/sweep-audit/plan";
import {
	createSweepAuditRecord,
	effectiveSweepAuditStatus,
	finishSweepAudit,
	redactSecrets,
	type SweepAuditInit,
	type SweepAuditRecord,
	sweepAuditFailed,
	sweepAuditJson,
	sweepAuditReportText,
	sweepAuditSummary,
	sweepAuditTransactions,
	withSweepProgress,
	withSweepStage,
} from "../lib/sweep-audit/record";
import {
	startSweepAudit,
	sweepAuditRunsHere,
} from "../lib/sweep-audit/recorder";
import {
	indexedDbSweepAuditStore,
	memorySweepAuditStore,
	type SweepAuditStore,
} from "../lib/sweep-audit/store";
import {
	executeKeySweep,
	type SweepActions,
	type SweepProgress,
} from "../lib/sweep-migration";
import { BSV20_UNREADABLE_REASON } from "../lib/wallet/migration-listings";
import { beefServices } from "./fixtures/sweep-beef";

const txid = (n: number) => n.toString(16).padStart(64, "0");
const outpoint = (n: number) => `${txid(n)}.0`;
const IDENTITY = PrivateKey.fromHex("0a".repeat(32)).toPublicKey().toString();
const PAY_ADDRESS = "1PayAddressxxxxxxxxxxxxxxxxxxxxxxx";

const init = (over: Partial<SweepAuditInit> = {}): SweepAuditInit => ({
	identityKey: IDENTITY,
	kind: "migration",
	chain: "main",
	app: { version: "0.0.1", commit: "abc123" },
	sources: [
		{
			address: PAY_ADDRESS,
			label: "Legacy pay",
			scheme: "original 1Sat payPk (bare WIF, P2PKH)",
		},
	],
	destination: "This wallet",
	scan: [{ kind: "BSV funding", found: 2, selected: 1 }],
	planLeftBehind: [
		{ outpoint: outpoint(9), kind: "BSV funding", reason: SKIPPED_BY_USER },
	],
	...over,
});

const at = (minute: number) =>
	new Date(`2026-11-17T10:${String(minute).padStart(2, "0")}:00.000Z`);

const progress = (over: Partial<SweepProgress> = {}): SweepProgress => ({
	message: "BSV sweep: batch 1/2 complete",
	percent: 50,
	steps: [
		{
			id: "bsv",
			label: "BSV funding (2 UTXOs)",
			status: "active",
			txids: [txid(100)],
			errors: [],
		},
	],
	errors: [],
	leftBehind: [],
	...over,
});

describe("sweep audit record", () => {
	it("keeps the source tx, its sizes and the exact error for a plain-words reason", () => {
		let record = createSweepAuditRecord(init(), "run-1", at(0));
		const reason =
			"Ordinal sweep: aa.0: this inscription's transaction is 9.1 MB, more than the wallet server accepts in one request; it stays at your old address.";
		record = withSweepProgress(
			record,
			progress({
				errors: [reason],
				leftBehind: [
					{
						outpoint: outpoint(3),
						stepId: "ordinals",
						reason,
						txid: txid(3),
						txBytes: 9_100_000,
						beefBytes: 9_100_200,
						detail: "WalletStorageClient rpcCall: network error 413",
					},
				],
			}),
		);
		const left = record.leftBehind.find((l) => l.stage === "sweep");
		assert.deepEqual(left, {
			outpoint: outpoint(3),
			kind: "ordinals",
			reason,
			stage: "sweep",
			txid: txid(3),
			txBytes: 9_100_000,
			beefBytes: 9_100_200,
			detail: "WalletStorageClient rpcCall: network error 413",
		});
		const text = sweepAuditReportText(record);
		assert.ok(text.includes(`source tx ${txid(3)}`));
		assert.ok(text.includes("tx 9100000 bytes; BEEF 9100200 bytes"));
		assert.ok(
			text.includes("error: WalletStorageClient rpcCall: network error 413"),
		);
	});

	it("starts running with sources, scan counts and the plan's leftovers", () => {
		const record = createSweepAuditRecord(init(), "run-1", at(0));
		assert.equal(record.status, "running");
		assert.equal(record.startedAt, "2026-11-17T10:00:00.000Z");
		assert.equal(record.finishedAt, null);
		assert.deepEqual(record.app, { version: "0.0.1", commit: "abc123" });
		assert.equal(record.sources[0].label, "Legacy pay");
		assert.deepEqual(record.leftBehind, [
			{
				outpoint: outpoint(9),
				kind: "BSV funding",
				reason: SKIPPED_BY_USER,
				stage: "plan",
			},
		]);
	});

	it("follows progress: steps, txids so far, errors and sweep leftovers", () => {
		let record = createSweepAuditRecord(init(), "run-1", at(0));
		record = withSweepStage(record, "sweep", at(1));
		record = withSweepProgress(
			record,
			progress({
				errors: ["BSV sweep (batch 2/2): broadcast refused"],
				leftBehind: [
					{
						outpoint: outpoint(2),
						stepId: "bsv",
						reason: "BSV sweep (batch 2/2): broadcast refused",
					},
				],
			}),
		);
		assert.deepEqual(record.stages, [
			{ stage: "sweep", at: "2026-11-17T10:01:00.000Z" },
		]);
		assert.deepEqual(record.steps[0].txids, [txid(100)]);
		assert.deepEqual(record.errors, [
			"BSV sweep (batch 2/2): broadcast refused",
		]);
		// The plan's leftovers stay; the sweep's are replaced by each report.
		assert.deepEqual(
			record.leftBehind.map((l) => [l.outpoint, l.stage]),
			[
				[outpoint(9), "plan"],
				[outpoint(2), "sweep"],
			],
		);
		record = withSweepProgress(record, progress());
		assert.deepEqual(
			record.leftBehind.map((l) => l.stage),
			["plan"],
		);
	});

	it("finishes with every txid, error and listing cancel verbatim", () => {
		const record = finishSweepAudit(
			createSweepAuditRecord(init(), "run-1", at(0)),
			{
				result: {
					bsvTxids: [txid(100)],
					ordinalTxids: [txid(101)],
					bsv20Txids: [],
					bsv21Txids: [],
					cancelTxids: [txid(102)],
					transferTxids: [txid(103)],
					cancelledListings: [outpoint(5)],
					errors: ["Ordinal sweep: skipped x (source tx 0000...: 404)"],
					leftBehind: [
						{
							outpoint: outpoint(6),
							stepId: "ordinals",
							reason: "Ordinal sweep: skipped x (source tx 0000...: 404)",
						},
					],
				},
				steps: progress().steps,
			},
			at(5),
		);
		assert.equal(record.status, "finished");
		assert.equal(record.finishedAt, "2026-11-17T10:05:00.000Z");
		assert.deepEqual(record.txids.cancel, [txid(102)]);
		assert.deepEqual(record.txids.transfer, [txid(103)]);
		assert.deepEqual(record.cancelledListings, [outpoint(5)]);
		assert.equal(record.leftBehind.length, 2);
		assert.equal(sweepAuditFailed(record), true);
		assert.deepEqual(
			sweepAuditTransactions(record).map((t) => t.txid),
			[txid(102), txid(103), txid(100), txid(101)],
		);
		assert.equal(sweepAuditSummary(record), "4 transactions, 2 left behind");
	});

	it("reads a run no page is running as interrupted", () => {
		const record = createSweepAuditRecord(init(), "run-1", at(0));
		assert.equal(effectiveSweepAuditStatus(record, new Set()), "interrupted");
		assert.equal(
			effectiveSweepAuditStatus(record, new Set(["run-1"])),
			"running",
		);
	});

	it("redacts anything shaped like a private key", () => {
		const wif = PrivateKey.fromRandom().toWif();
		assert.equal(redactSecrets(`bad key ${wif}!`), "bad key [redacted key]!");
		// Addresses, txids and outpoints are left alone.
		assert.equal(redactSecrets(PAY_ADDRESS), PAY_ADDRESS);
		assert.equal(redactSecrets(outpoint(3)), outpoint(3));
	});
});

describe("sweep audit plan", () => {
	const listed = (n: number) => ({
		outpoint: outpoint(n),
		events: ["ordlock2"],
	});
	const scan = {
		funding: [{ outpoint: outpoint(1) }, { outpoint: outpoint(2) }],
		ordinals: [{ outpoint: outpoint(3) }, { outpoint: outpoint(4) }, listed(5)],
		opnsNames: [],
		bsv21Tokens: [{ outputs: [{ outpoint: outpoint(6) }] }],
		bsv20Balances: [],
		bsv20Unsweepable: [
			{ output: { outpoint: outpoint(7) }, reason: BSV20_UNREADABLE_REASON },
		],
		locked: [{ outpoint: outpoint(8) }],
		run: [],
		listings: [listed(5)],
	};

	it("counts each class and gives every unsent output its reason", () => {
		const { scan: counts, planLeftBehind } = auditPlanFromScan(
			scan,
			{
				cancel: [],
				sweepListed: [],
				sweepOrdinals: [{ outpoint: outpoint(3) }],
				sweepFunding: [{ outpoint: outpoint(1) }, { outpoint: outpoint(2) }],
				sweepBsv21: [{ outputs: [{ outpoint: outpoint(6) }] }],
				sweepBsv20: [],
			},
			{
				listings: [{ outpoint: outpoint(5), id: null, source: "legacy" }],
			},
		);
		const byKind = Object.fromEntries(counts.map((c) => [c.kind, c]));
		assert.deepEqual(byKind["BSV funding"], {
			kind: "BSV funding",
			found: 2,
			selected: 2,
		});
		assert.deepEqual(byKind.Ordinals, {
			kind: "Ordinals",
			found: 2,
			selected: 1,
		});
		assert.equal(byKind.Listings.selected, 0);
		assert.equal(byKind["BSV-20 outputs"].found, 1);
		const reasons = Object.fromEntries(
			planLeftBehind.map((l) => [l.outpoint, l.reason]),
		);
		assert.equal(reasons[outpoint(4)], SKIPPED_BY_USER);
		assert.match(reasons[outpoint(5)], /listings were not included/);
		assert.equal(reasons[outpoint(7)], `BSV-20: ${BSV20_UNREADABLE_REASON}`);
		assert.match(reasons[outpoint(8)], /time-locked/);
		assert.equal(planLeftBehind.length, 4);
	});
});

const roundTrip = async (store: SweepAuditStore) => {
	const other = PrivateKey.fromHex("0b".repeat(32)).toPublicKey().toString();
	const first = createSweepAuditRecord(init(), "run-1", at(0));
	const second = finishSweepAudit(
		createSweepAuditRecord(init(), "run-2", at(3)),
		{ result: null },
		at(4),
	);
	const foreign = createSweepAuditRecord(
		init({ identityKey: other }),
		"run-3",
		at(5),
	);
	await store.put(first);
	await store.put(second);
	await store.put(foreign);
	// A later save of the same run replaces it.
	await store.put(withSweepStage(first, "sweep", at(1)));

	const mine = await store.list(IDENTITY);
	assert.deepEqual(
		mine.map((r) => r.id),
		["run-2", "run-1"],
	);
	assert.equal(mine[1].stages.length, 1);
	assert.deepEqual(await store.get(IDENTITY, "run-2"), second);
	// Another wallet's run is never listed or opened here.
	assert.equal(await store.get(IDENTITY, "run-3"), null);
	assert.deepEqual(
		(await store.list(other)).map((r) => r.id),
		["run-3"],
	);
};

describe("sweep audit storage", () => {
	it("round-trips through IndexedDB, newest first, per wallet", async () => {
		await roundTrip(indexedDbSweepAuditStore(new IDBFactory()));
	});

	it("round-trips through the memory store the same way", async () => {
		await roundTrip(memorySweepAuditStore());
	});

	it("keeps a record across reopening the database", async () => {
		const factory = new IDBFactory();
		await indexedDbSweepAuditStore(factory).put(
			createSweepAuditRecord(init(), "run-1", at(0)),
		);
		const again = await indexedDbSweepAuditStore(factory).list(IDENTITY);
		assert.deepEqual(
			again.map((r) => r.id),
			["run-1"],
		);
	});
});

describe("sweep audit recorder", () => {
	it("saves at start and after each change; a closed tab leaves an interrupted run with its txids", async () => {
		const store = memorySweepAuditStore();
		const run = startSweepAudit(init(), {
			store,
			newId: () => "run-1",
			now: () => at(0),
		});
		await run.flushed();
		assert.equal((await store.get(IDENTITY, "run-1"))?.status, "running");

		run.progress(progress());
		// Detail-only progress (fetching source txs) changes nothing saved.
		run.progress(progress({ message: "fetching source txs 3/9" }));
		await run.flushed();
		const saved = (await store.get(IDENTITY, "run-1")) as SweepAuditRecord;
		assert.deepEqual(saved.steps[0].txids, [txid(100)]);

		// The page goes away here: no finish. Another page reads it later.
		assert.equal(effectiveSweepAuditStatus(saved, new Set()), "interrupted");
		assert.equal(
			effectiveSweepAuditStatus(saved, sweepAuditRunsHere()),
			"running",
		);
		run.finish(null);
		await run.flushed();
		assert.equal((await store.get(IDENTITY, "run-1"))?.status, "finished");
		assert.equal(sweepAuditRunsHere().has("run-1"), false);
	});

	it("logs a failed save, reports it, and saves again on the next change", async () => {
		const memory = memorySweepAuditStore();
		let fail = true;
		const store: SweepAuditStore = {
			...memory,
			put: (record) =>
				fail ? Promise.reject(new Error("quota")) : memory.put(record),
		};
		const reported: string[] = [];
		const originalError = console.error;
		const logged: unknown[] = [];
		console.error = (...args: unknown[]) => logged.push(args);
		try {
			const run = startSweepAudit(init(), {
				store,
				newId: () => "run-1",
				onSaveError: (message) => reported.push(message),
			});
			await run.flushed();
			assert.equal(reported.length, 1);
			assert.equal(logged.length, 1);
			fail = false;
			run.fail(new Error("Failed to re-encrypt wallet"), null);
			await run.flushed();
			const saved = await memory.get(IDENTITY, "run-1");
			assert.equal(saved?.failure, "Failed to re-encrypt wallet");
		} finally {
			console.error = originalError;
		}
	});
});

describe("sweep audit never holds a secret", () => {
	it("a real sweep run's record and report hold no WIF", async () => {
		const pay = PrivateKey.fromRandom();
		const ord = PrivateKey.fromRandom();
		const pasted = PrivateKey.fromRandom();
		const wifs = [pay.toWif(), ord.toWif(), pasted.toWif()];
		const owner = (key: PrivateKey) => `own:${key.toPublicKey().toAddress()}`;
		const out = (n: number, key: PrivateKey): IndexedOutput => ({
			outpoint: outpoint(n),
			satoshis: 1,
			score: n,
			events: [owner(key)],
		});
		const token: TokenBalance = {
			tokenId: `${txid(999)}_0`,
			symbol: "TOK",
			decimals: 0,
			totalAmount: 0n,
			outputs: [out(20, ord), out(21, ord)],
			amounts: new Map([
				[outpoint(20), "5"],
				[outpoint(21), "7"],
			]),
			isActive: true,
		};
		let calls = 0;
		const actions: Partial<SweepActions> = {
			prepareSweepInputs: async (_ctx, utxos) => {
				// One source tx can't be fetched.
				if (utxos.some((u) => u.outpoint === outpoint(3))) {
					throw new Error("404 not found");
				}
				return utxos.map((u) => ({
					outpoint: u.outpoint,
					satoshis: u.satoshis ?? 1,
					lockingScript: "76a914",
				}));
			},
			sweepBsv: (async () => ({
				txid: txid(500 + calls++),
			})) as SweepActions["sweepBsv"],
			// A library that leaks a key into its error must not leak it here.
			sweepOrdinals: (async () => ({
				error: `signing failed for ${ord.toWif()}`,
			})) as SweepActions["sweepOrdinals"],
			sweepBsv20: (async () => ({
				txid: txid(600),
			})) as SweepActions["sweepBsv20"],
			sweepBsv21: (async () => ({
				txid: txid(700),
				spentOutpoints: [outpoint(20)],
			})) as SweepActions["sweepBsv21"],
		};

		const store = memorySweepAuditStore();
		const trail = startSweepAudit(
			init({
				kind: "key-sweep",
				sources: [pay, ord, pasted].map((key, i) => ({
					address: key.toPublicKey().toAddress(),
					label: ["Payment key", "Ordinals key", "Private key"][i],
					scheme: "pasted key (WIF backup)",
				})),
			}),
			{ store, newId: () => "run-secret" },
		);
		const originalError = console.error;
		console.error = () => undefined;
		try {
			const result = await executeKeySweep({
				wallet: {} as WalletInterface,
				services: beefServices(),
				keys: [
					{ label: "Payment key", wif: wifs[0] },
					{ label: "Ordinals key", wif: wifs[1] },
					{ label: "Private key", wif: wifs[2] },
					{ label: "Broken key", wif: "not-a-wif" },
				],
				onProgress: (p) => trail.progress(p),
				funding: [out(1, pay), out(2, pasted), out(3, pay)],
				ordinals: [out(10, ord)],
				bsv21Tokens: [token],
				actions,
				logPrefix: "[test]",
			});
			trail.finish(result);
		} finally {
			console.error = originalError;
		}
		await trail.flushed();

		const record = (await store.get(
			IDENTITY,
			"run-secret",
		)) as SweepAuditRecord;
		// The run is fully described...
		assert.equal(record.status, "finished");
		assert.ok(record.txids.bsv.length > 0);
		assert.deepEqual(record.txids.bsv21, [txid(700)]);
		const left = Object.fromEntries(
			record.leftBehind.map((l) => [l.outpoint, l.reason]),
		);
		assert.match(left[outpoint(3)], /404 not found/);
		assert.match(left[outpoint(10)], /signing failed for \[redacted key\]/);
		assert.match(left[outpoint(21)], /not accepted by the token overlay/);
		assert.ok(record.errors.some((e) => e.startsWith("Broken key key")));

		// ...and holds no key anywhere: stored, exported or rendered.
		const outputs = [
			JSON.stringify(record),
			sweepAuditJson(record),
			sweepAuditReportText(record),
			renderToStaticMarkup(<SweepAuditView record={record} />),
		];
		for (const text of outputs) {
			for (const wif of wifs) {
				assert.equal(text.includes(wif), false, "a WIF leaked");
			}
			assert.equal(text.includes(pay.toHex()), false, "a key leaked");
		}
	});
});

describe("sweep audit record view", () => {
	it("shows steps, explorer links, reasons, exact errors and the exports", () => {
		const record = finishSweepAudit(
			withSweepProgress(
				createSweepAuditRecord(init(), "run-1", at(0)),
				progress({
					steps: [
						{
							id: "bsv",
							label: "BSV funding (2 UTXOs)",
							status: "error",
							txids: [txid(100)],
							error: "1 of 2 batches failed",
							errors: ["BSV sweep (batch 2/2): fee too low"],
						},
					],
				}),
			),
			{
				result: {
					bsvTxids: [txid(100)],
					ordinalTxids: [],
					bsv20Txids: [],
					bsv21Txids: [],
					cancelTxids: [txid(102)],
					cancelledListings: [],
					errors: ["BSV sweep (batch 2/2): fee too low"],
					leftBehind: [
						{
							outpoint: outpoint(2),
							stepId: "bsv",
							reason: "BSV sweep (batch 2/2): fee too low",
						},
					],
				},
			},
			at(2),
		);
		const html = renderToStaticMarkup(<SweepAuditView record={record} />);
		assert.match(html, /Wallet migration/);
		assert.match(html, /Failed/);
		assert.match(html, /Copy report/);
		assert.match(html, /Download/);
		assert.match(html, /BSV funding \(2 UTXOs\)/);
		assert.match(html, /1 of 2 batches failed/);
		assert.ok(html.includes(`https://whatsonchain.com/tx/${txid(100)}`));
		// The listing cancel is outside every step.
		assert.match(html, /Other transactions \(1\)/);
		assert.ok(html.includes(`https://whatsonchain.com/tx/${txid(102)}`));
		assert.match(html, /Left behind \(2\)/);
		assert.ok(html.includes(outpoint(9)));
		assert.match(html, /skipped by user/);
		assert.match(html, /BSV sweep \(batch 2\/2\): fee too low/);
		assert.match(html, /Legacy pay/);
		assert.ok(html.includes(PAY_ADDRESS));

		const text = sweepAuditReportText(record);
		assert.match(text, /Status: Finished/);
		assert.match(text, /App: 0\.0\.1 \(abc123\)/);
		assert.ok(text.includes(`tx ${txid(100)}`));
		assert.ok(text.includes(`${outpoint(2)} [bsv]: BSV sweep (batch 2/2)`));
	});

	it("shows an interrupted run as interrupted", () => {
		const record = createSweepAuditRecord(init(), "run-1", at(0));
		const html = renderToStaticMarkup(
			<SweepAuditView record={record} status="interrupted" />,
		);
		assert.match(html, /Interrupted/);
		assert.match(html, /No transactions were sent/);
		assert.match(
			sweepAuditReportText(record, "interrupted"),
			/Status: Interrupted/,
		);
	});
});

describe("sweep history entry points", () => {
	it("is a settings sub-page under the mainnet-only sweep routes", async () => {
		const { walletSubPageFor } = await import("../lib/wallet-sections");
		const { isRouteAvailableOn } = await import("../lib/chain-surfaces");
		assert.equal(
			walletSubPageFor("/wallet/sweep/history")?.title,
			"Sweep history",
		);
		assert.equal(
			walletSubPageFor("/wallet/sweep")?.title,
			"Sweep a private key",
		);
		assert.equal(isRouteAvailableOn("test", "/wallet/sweep/history"), false);
	});
});
