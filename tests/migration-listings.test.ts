import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { OneSatContext, WalletOutput } from "@1sat/actions";
import {
	ASSET_TYPES,
	cancelListedAssets,
	defaultAssetTypes,
	excludeUnsweepableTokens,
	isListedOutput,
	isolateListedBatches,
	listedFromLegacy,
	listedFromWallet,
	MNEE_TOKEN_ID,
	mergeListed,
	onlyListedTokens,
	planMigration,
	plannedCount,
	toggleAssetType,
	tokenOutputCount,
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
		});
		assert.equal(all.cancel.length, 1);
		assert.equal(all.sweepListed.length, 1);
		assert.equal(all.sweepOrdinals.length, 1);
		assert.equal(all.sweepFunding.length, 1);
		assert.equal(all.sweepBsv21.length, 1);
		assert.equal(plannedCount(all), 5);

		const listingsOnly = planMigration({
			types: new Set(["listings"]),
			listings,
			listedLegacyOutputs: listedLegacy,
			ordinals,
			opns: [],
			funding,
			bsv21: all.sweepBsv21,
		});
		assert.equal(listingsOnly.cancel.length, 1);
		assert.equal(listingsOnly.sweepListed.length, 1);
		assert.equal(listingsOnly.sweepOrdinals.length, 0);
		assert.equal(listingsOnly.sweepFunding.length, 0);
		assert.equal(listingsOnly.sweepBsv21.length, 0);
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

describe("OrdLock v2 listings", () => {
	it("recognises v2 listings by tag event, list: event or data, and keeps v1", () => {
		const v2Event = { outpoint: tx("a1"), events: ["ordlock2"] };
		const listEvent = { outpoint: tx("a2"), events: ["list:1000"] };
		const v2Data = { outpoint: tx("a3"), data: { ordlock2: { price: 1 } } };
		const v1 = { outpoint: tx("a4"), events: ["ordlock"] };
		const plain = { outpoint: tx("a5"), events: ["type:image/png"] };
		for (const listed of [v2Event, listEvent, v2Data, v1]) {
			assert.equal(isListedOutput(listed), true, listed.outpoint);
		}
		assert.equal(isListedOutput(plain), false);
		assert.deepEqual(
			listedFromLegacy([v2Event, plain, listEvent]).map((l) => l.outpoint),
			[v2Event.outpoint, listEvent.outpoint],
		);
	});

	it("puts every listed output in its own batch and chunks the rest", () => {
		const listed = [
			{ outpoint: tx("b1"), events: ["ordlock2"] },
			{ outpoint: tx("b2"), events: ["list:5"] },
		];
		const unlisted = Array.from({ length: 5 }, (_, i) => ({
			outpoint: `${"c".repeat(63)}${i}.0`,
		}));
		const batches = isolateListedBatches(
			[unlisted[0], listed[0], ...unlisted.slice(1), listed[1]],
			2,
		);
		assert.deepEqual(
			batches.map((batch) => batch.map((o) => o.outpoint)),
			[
				[listed[0].outpoint],
				[listed[1].outpoint],
				[unlisted[0].outpoint, unlisted[1].outpoint],
				[unlisted[2].outpoint, unlisted[3].outpoint],
				[unlisted[4].outpoint],
			],
		);
		assert.deepEqual(isolateListedBatches([], 2), []);
	});
});

describe("BSV-20 in the migration plan", () => {
	const bsv20 = (outpoints: { outpoint: string; events?: string[] }[]) => ({
		tick: "PEPE",
		decimals: 0,
		totalAmount: 3n,
		outputs: outpoints.map((o) => ({ ...o, score: 0 })),
		amounts: new Map(outpoints.map((o) => [o.outpoint, "1"])),
	});
	const base = {
		listings: [],
		listedLegacyOutputs: [],
		ordinals: [],
		opns: [],
		funding: [],
		bsv21: [],
	};

	it("plans and counts BSV-20 outputs when the type is selected", () => {
		const tokens = [bsv20([{ outpoint: tx("d1") }, { outpoint: tx("d2") }])];
		const plan = planMigration({
			...base,
			types: defaultAssetTypes(),
			bsv20: tokens,
		});
		assert.equal(tokenOutputCount(plan.sweepBsv20), 2);
		assert.equal(plannedCount(plan), 2);
		assert.ok(ASSET_TYPES.includes("bsv20"));

		const without = planMigration({
			...base,
			types: toggleAssetType(defaultAssetTypes(), "bsv20"),
			bsv20: tokens,
		});
		assert.deepEqual(without.sweepBsv20, []);
		assert.equal(plannedCount(without), 0);
	});

	it("leaves listed token outputs out when listings are not selected", () => {
		const listed = { outpoint: tx("e1"), events: ["ordlock2"] };
		const plain = { outpoint: tx("e2") };
		const tokens = [bsv20([listed, plain])];
		const types = toggleAssetType(defaultAssetTypes(), "listings");
		const plan = planMigration({ ...base, types, bsv20: tokens });
		assert.deepEqual(
			plan.sweepBsv20.flatMap((t) => t.outputs.map((o) => o.outpoint)),
			[plain.outpoint],
		);
		assert.deepEqual(
			onlyListedTokens(tokens).flatMap((t) => t.outputs.map((o) => o.outpoint)),
			[listed.outpoint],
		);
	});
});

describe("migration listing UI contract", () => {
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

describe("excludeUnsweepableTokens", () => {
	it("drops MNEE, which the plain P2PKH sweep cannot sign, and keeps other tokens", () => {
		const other = { tokenId: `${"b".repeat(64)}_0`, amount: "5" };
		const mnee = { tokenId: MNEE_TOKEN_ID, amount: "2" };
		assert.deepEqual(excludeUnsweepableTokens([mnee, other]), [other]);
		assert.deepEqual(excludeUnsweepableTokens([other]), [other]);
	});
});
