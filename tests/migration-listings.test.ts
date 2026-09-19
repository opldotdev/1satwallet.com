import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { OneSatContext, WalletOutput } from "@1sat/actions";
import type { MigrationSweepParams, SweepResult } from "@/lib/sweep-migration";
import {
	ASSET_TYPES,
	cancelListedAssets,
	defaultAssetTypes,
	delistMigrationListings,
	isListedOutput,
	listedFromLegacy,
	listedFromWallet,
	mergeListed,
	planMigration,
	plannedCount,
	toggleAssetType,
	withoutListed,
} from "@/lib/wallet/migration-listings";
import type { OrdinalActionSet } from "@/lib/wallet/ordinal-actions";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const tx = (n: string) => `${n.repeat(32)}.0`;

const walletOut = (
	outpoint: string,
	tags: string[] = ["id:asset-1", "ordlock"],
): WalletOutput => ({
	outpoint,
	satoshis: 1,
	spendable: true,
	tags,
});

describe("migration listing plan", () => {
	it("lifts listed outputs out of other UTXOs", () => {
		const listed = {
			outpoint: tx("aa"),
			events: ["ordlock"],
			data: { ordlock: { price: 1 } },
		};
		const plain = { outpoint: tx("bb"), events: ["type:image/png"] };
		assert.equal(isListedOutput(listed), true);
		assert.equal(isListedOutput(plain), false);
		assert.deepEqual(
			withoutListed([listed, plain]).map((item) => item.outpoint),
			[plain.outpoint],
		);
		assert.deepEqual(
			listedFromLegacy([listed, plain]).map((item) => item.outpoint),
			[listed.outpoint],
		);
	});

	it("prefers wallet listings with asset IDs over the same legacy outpoint", () => {
		const outpoint = tx("aa");
		const merged = mergeListed(listedFromWallet([walletOut(outpoint)]), [
			{ outpoint, id: null, source: "legacy" },
		]);
		assert.deepEqual(merged, [{ outpoint, id: "asset-1", source: "wallet" }]);
	});

	it("plans only the selected asset types", () => {
		const listings = listedFromWallet([walletOut(tx("aa"))]);
		const listedLegacy = [{ outpoint: tx("cc"), events: ["ordlock"] }];
		const ordinals = [{ outpoint: tx("bb"), events: ["type:image/png"] }];
		const funding = [{ outpoint: tx("dd") }];
		const all = planMigration({
			types: defaultAssetTypes(),
			listings,
			listedLegacyOutputs: listedLegacy,
			ordinals,
			opns: [],
			funding,
			bsv21: [
				{
					tokenId: "tok",
					symbol: "TOK",
					decimals: 0,
					totalAmount: 1n,
					outputs: [{ outpoint: tx("ee") } as never],
					amounts: new Map(),
					isActive: true,
				},
			],
			mneeBalance: 2,
		});
		assert.equal(all.cancel.length, 1);
		assert.equal(all.sweepListed.length, 1);
		assert.equal(all.sweepOrdinals.length, 1);
		assert.equal(all.sweepFunding.length, 1);
		assert.equal(all.sweepBsv21.length, 1);
		assert.equal(all.sweepMnee, true);
		assert.equal(plannedCount(all), 6);

		const listingsOnly = planMigration({
			types: new Set(["listings"]),
			listings,
			listedLegacyOutputs: listedLegacy,
			ordinals,
			opns: [],
			funding,
			bsv21: all.sweepBsv21,
			mneeBalance: 2,
		});
		assert.equal(listingsOnly.cancel.length, 1);
		assert.equal(listingsOnly.sweepListed.length, 1);
		assert.equal(listingsOnly.sweepOrdinals.length, 0);
		assert.equal(listingsOnly.sweepFunding.length, 0);
		assert.equal(listingsOnly.sweepBsv21.length, 0);
		assert.equal(listingsOnly.sweepMnee, false);
		assert.deepEqual(
			[...toggleAssetType(defaultAssetTypes(), "bsv")],
			[...ASSET_TYPES.filter((type) => type !== "bsv")],
		);
	});

	it("cancels each listing through the existing cancel action", async () => {
		const calls: unknown[] = [];
		const actions: OrdinalActionSet = {
			send: async () => ({ txid: "send" }),
			burn: async () => ({ txid: "burn" }),
			sell: async () => ({ txid: "sell" }),
			cancel: async (_ctx, input) => {
				calls.push(input);
				return { txid: "cancel-1" };
			},
		};
		const result = await cancelListedAssets(
			{} as OneSatContext,
			[{ outpoint: tx("aa"), id: "one", source: "wallet" }],
			actions,
		);
		assert.equal(result.ok, true);
		assert.deepEqual(result.txids, ["cancel-1"]);
		assert.deepEqual(calls, [{ id: "one" }]);
	});

	it("blocks migrate-away when a selected listing cannot be cancelled", async () => {
		const result = await cancelListedAssets({} as OneSatContext, [
			{ outpoint: tx("aa"), id: null, source: "wallet" },
		]);
		assert.equal(result.ok, false);
		assert.match(result.errors[0] ?? "", /asset ID/);
		assert.doesNotMatch(result.errors.join(" "), /seed|wif|private/i);
	});
});

describe("delist-only execution", () => {
	const legacyOutputs = [
		{ outpoint: tx("bb"), events: ["ordlock"], satoshis: 1, score: 0 },
		{
			outpoint: tx("cc"),
			events: ["lock:example", "ordlock"],
			satoshis: 1,
			score: 0,
		},
		{
			outpoint: tx("dd"),
			events: ["run:example", "ordlock"],
			satoshis: 1,
			score: 0,
		},
	];
	const input = {
		ctx: {} as OneSatContext,
		listings: mergeListed(
			listedFromWallet([walletOut(tx("aa"))]),
			listedFromLegacy(legacyOutputs),
		),
		legacyOutputs,
		sweepParams: {
			wallet: {} as MigrationSweepParams["wallet"],
			services: {} as MigrationSweepParams["services"],
			legacyPayWif: "unused-test-value",
			legacyOrdWif: "unused-test-value",
			onProgress: () => {},
		},
	};
	const result = (
		ordinalTxids: string[] = [],
		errors: string[] = [],
	): SweepResult => ({
		bsvTxids: [],
		ordinalTxids,
		bsv21Txids: [],
		errors,
	});
	const actions: OrdinalActionSet = {
		send: async () => {
			throw new Error("Unexpected send");
		},
		burn: async () => {
			throw new Error("Unexpected burn");
		},
		sell: async () => {
			throw new Error("Unexpected sell");
		},
		cancel: async () => ({ txid: "wallet-cancel" }),
	};

	it("returns every legacy listing through the sweep action, with other assets excluded", async () => {
		const swept: string[] = [];
		const response = await delistMigrationListings(
			{ ...input, listings: listedFromLegacy(legacyOutputs) },
			{
				...actions,
				cancel: async () => {
					throw new Error("Legacy listings cannot use wallet asset IDs");
				},
			},
			async (params) => {
				assert.deepEqual(params.funding, []);
				assert.deepEqual(params.bsv21Tokens, []);
				assert.equal(params.mneeBalance, 0);
				assert.equal(params.ordinals.length, 1);
				swept.push(params.ordinals[0].outpoint);
				return result([`legacy-${swept.length}`]);
			},
		);
		assert.deepEqual(
			swept,
			legacyOutputs.map((output) => output.outpoint),
		);
		assert.deepEqual(response.completedOutpoints, swept);
		assert.deepEqual(response.errors, []);
		assert.deepEqual(response.cancelTxids, []);
	});

	it("cancels a mixed inventory even when migration types are deselected", async () => {
		const migration = planMigration({
			types: new Set(),
			listings: input.listings,
			listedLegacyOutputs: legacyOutputs,
			ordinals: [],
			opns: [],
			funding: [],
			bsv21: [],
			mneeBalance: 0,
		});
		assert.equal(plannedCount(migration), 0);
		const response = await delistMigrationListings(
			input,
			actions,
			async (params) => result([params.ordinals[0].outpoint]),
		);
		assert.deepEqual(response.cancelTxids, ["wallet-cancel"]);
		assert.equal(response.ordinalTxids.length, legacyOutputs.length);
		assert.deepEqual(
			response.completedOutpoints,
			input.listings.map((listing) => listing.outpoint),
		);
		assert.deepEqual(response.errors, []);
	});

	it("refuses success for missing transaction IDs, missing legacy prerequisites, and zero work", async () => {
		const noTxid = await cancelListedAssets(
			input.ctx,
			input.listings.slice(0, 1),
			{ ...actions, cancel: async () => ({}) },
		);
		assert.equal(noTxid.ok, false);
		assert.match(noTxid.errors.join(" "), /no transaction ID/);
		const legacy = { ...input, listings: listedFromLegacy(legacyOutputs) };
		for (const invalidInput of [
			legacy,
			{ ...legacy, sweepParams: null },
			{ ...legacy, legacyOutputs: [] },
			{ ...input, listings: [] },
		]) {
			const response = await delistMigrationListings(
				invalidInput,
				actions,
				async () => result(),
			);
			assert.deepEqual(response.completedOutpoints, []);
			assert.ok(response.errors.length > 0);
		}
	});

	it("keeps partial successes out of retries and continues after a cancellation throws", async () => {
		const attempts: string[] = [];
		const sweep = async (params: MigrationSweepParams) => {
			const outpoint = params.ordinals[0].outpoint;
			attempts.push(outpoint);
			if (outpoint === legacyOutputs[1].outpoint && attempts.length === 2)
				throw new Error("declined");
			return result([outpoint]);
		};
		const first = await delistMigrationListings(input, actions, sweep);
		assert.equal(first.errors.length, 1);
		assert.equal(first.completedOutpoints.length, 3);
		assert.deepEqual(
			attempts,
			legacyOutputs.map((output) => output.outpoint),
		);
		const second = await delistMigrationListings(
			{
				...input,
				listings: input.listings.filter(
					(listing) => !first.completedOutpoints.includes(listing.outpoint),
				),
			},
			{
				...actions,
				cancel: async () => {
					throw new Error("Already cancelled");
				},
			},
			sweep,
		);
		assert.deepEqual(second.errors, []);
		assert.deepEqual(second.completedOutpoints, [legacyOutputs[1].outpoint]);
		assert.deepEqual(attempts, [
			...legacyOutputs.map((output) => output.outpoint),
			legacyOutputs[1].outpoint,
		]);
	});

	it("retains a reported sweep failure even if a transaction ID is also returned", async () => {
		const response = await delistMigrationListings(
			{ ...input, listings: listedFromLegacy(legacyOutputs.slice(0, 1)) },
			actions,
			async () => result(["partial"], ["Output could not be returned"]),
		);
		assert.deepEqual(response.ordinalTxids, ["partial"]);
		assert.deepEqual(response.completedOutpoints, []);
		assert.deepEqual(response.errors, ["Output could not be returned"]);
	});
});

describe("migration listing UI contract", () => {
	it("both delist buttons execute the complete inventory and keep failures retryable", () => {
		for (const path of [
			"app/(main)/wallet/migrate/page.tsx",
			"components/wallet/migration-wizard.tsx",
		]) {
			const source = read(path);
			const handler = source.slice(
				source.indexOf("const runDelistOnly ="),
				source.indexOf("\n\t}, [", source.indexOf("const runDelistOnly =")),
			);
			assert.match(handler, /await delistMigrationListings\(/);
			assert.match(handler, /\n\s+listings,/);
			assert.match(handler, /legacyOutputs: listedLegacyOutputs/);
			assert.doesNotMatch(handler, /plan\.|selectedTypes|runDelist\(/);
			assert.match(handler, /setCompletedListings/);
			assert.match(source, /!completedListings.has\(item.outpoint\)/);
			assert.match(
				handler,
				/if \(result.errors.length > 0\)[\s\S]*?"error"\);\s+return;/,
			);
			assert.match(source, /Listings Cancelled/);
			assert.match(source, /Listing Cancellation Incomplete/);
		}
	});

	it("shows listings as a check item with delist-only and type picks", () => {
		const source = [
			"app/(main)/wallet/migrate/page.tsx",
			"components/wallet/migration-wizard.tsx",
			"components/wallet/migration-sections.tsx",
			"lib/wallet/migration-listings.ts",
		]
			.map(read)
			.join("\n");
		assert.match(source, /Open listings/);
		assert.match(source, /Cancel listings only/);
		assert.match(source, /ASSET_TYPES/);
		assert.match(source, /cancelListedAssets/);
		assert.match(source, /kind: "cancel"/);
		assert.match(source, /selectedTypes/);
		assert.doesNotMatch(source, /vulnerability|how the listing contract/i);
		assert.doesNotMatch(
			read("lib/wallet/migration-listings.ts"),
			/sellOrdinal|auto-send|seedPhrase/,
		);
	});
});
