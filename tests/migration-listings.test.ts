import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { OneSatContext, WalletOutput } from "@1sat/actions";
import {
	ASSET_TYPES,
	cancelListedAssets,
	defaultAssetTypes,
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
