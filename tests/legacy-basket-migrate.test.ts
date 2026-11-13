import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ONESAT_BASKET } from "@1sat/types";
import {
	Beef,
	type InternalizeActionArgs,
	type ListOutputsResult,
	P2PKH,
	PrivateKey,
	Transaction,
	type WalletInterface,
} from "@bsv/sdk";
import {
	defaultsKey,
	isDue,
	LEFTOVER_ORDINALS_BASKET,
	LEGACY_P1SAT_BASKET_MIGRATIONS,
	legacyBasketMigrations,
	type MoveBasketResult,
	mappingVersion,
	migrateIfNeeded,
	migrateLegacyBaskets,
	moveBasketOutputs,
} from "@/lib/wallet/legacy-basket-migrate";

const wallet = {} as WalletInterface;

const emptyMove = (from: string, to: string): MoveBasketResult => ({
	from,
	to,
	moved: 0,
	skipped: 0,
	outpoints: [],
	errors: [],
});

function memoryStorage(initial: Record<string, string> = {}) {
	const data = { ...initial };
	return {
		getItem(key: string) {
			return data[key] ?? null;
		},
		setItem(key: string, value: string) {
			data[key] = value;
		},
		data,
	};
}

describe("legacy basket migrate", () => {
	it("keeps leftover theme-token ordinals once in the migrate list", () => {
		const rows = legacyBasketMigrations();
		assert.deepEqual(
			rows.filter((row) => row.to === ONESAT_BASKET).map((row) => row.from),
			["p 1sat ordinals", LEFTOVER_ORDINALS_BASKET],
		);
		assert.equal(
			legacyBasketMigrations([
				...LEGACY_P1SAT_BASKET_MIGRATIONS,
				{ from: LEFTOVER_ORDINALS_BASKET, to: ONESAT_BASKET },
			]).filter((row) => row.from === LEFTOVER_ORDINALS_BASKET).length,
			1,
		);
	});

	it("uses the published leftover-ordinals mapping version", () => {
		assert.equal(
			mappingVersion(LEGACY_P1SAT_BASKET_MIGRATIONS),
			mappingVersion(legacyBasketMigrations()),
		);
		assert.match(mappingVersion(), /ordinals>1sat/);
	});

	it("moves leftover ordinals and marks complete only when every source is empty or moved", async () => {
		const calls: string[] = [];
		const result = await migrateLegacyBaskets(wallet, {
			move: async (_wallet, from, to) => {
				calls.push(`${from}>${to}`);
				if (from === LEFTOVER_ORDINALS_BASKET) {
					return {
						from,
						to,
						moved: 2,
						skipped: 0,
						outpoints: ["aa.0", "bb.0"],
						errors: [],
					};
				}
				return emptyMove(from, to);
			},
		});
		assert.ok(calls.includes(`${LEFTOVER_ORDINALS_BASKET}>${ONESAT_BASKET}`));
		assert.equal(result.totalMoved, 2);
		assert.equal(result.complete, true);
	});

	it("retries when a source skip or throw happens", async () => {
		const storage = memoryStorage();
		const identity = "03ab";
		const first = await migrateIfNeeded({
			wallet,
			identityHex: identity,
			storage,
			move: async (_wallet, from, to) => {
				if (from === LEFTOVER_ORDINALS_BASKET) {
					throw new Error("no-beef");
				}
				return emptyMove(from, to);
			},
		});
		assert.equal(first.complete, false);
		assert.equal(isDue(identity, storage), true);

		const second = await migrateIfNeeded({
			wallet,
			identityHex: identity,
			storage,
			move: async (_wallet, from, to) => emptyMove(from, to),
		});
		assert.equal(second.complete, true);
		assert.equal(isDue(identity, storage), false);
		assert.equal(storage.getItem(defaultsKey(identity)), "1");

		const third = await migrateIfNeeded({
			wallet,
			identityHex: identity,
			storage,
			move: async () => {
				throw new Error("should not run");
			},
		});
		assert.equal(third.ran, false);
	});
});

describe("moveBasketOutputs", () => {
	function fakeWallet(listed: ListOutputsResult) {
		const internalized: InternalizeActionArgs[] = [];
		const wallet = {
			listOutputs: async () => listed,
			internalizeAction: async (args: InternalizeActionArgs) => {
				internalized.push(args);
				return { accepted: true };
			},
		} as unknown as WalletInterface;
		return { wallet, internalized };
	}

	it("re-files each output into the target basket with its tags", async () => {
		const tx = new Transaction();
		tx.addOutput({
			lockingScript: new P2PKH().lock(
				PrivateKey.fromHex("01".repeat(32)).toAddress(),
			),
			satoshis: 1,
		});
		const beef = new Beef();
		beef.mergeTransaction(tx);
		const txid = tx.id("hex");
		const { wallet, internalized } = fakeWallet({
			totalOutputs: 2,
			BEEF: beef.toBinary(),
			outputs: [
				{
					outpoint: `${txid}.0`,
					satoshis: 1,
					spendable: true,
					tags: ["origin:abc"],
					customInstructions: "ci",
				},
				{ outpoint: "not-an-outpoint", satoshis: 1, spendable: true },
			],
		});

		const result = await moveBasketOutputs(wallet, "p 1sat ordinals", "1sat");

		assert.equal(result.moved, 1);
		assert.equal(result.skipped, 1);
		assert.deepEqual(result.outpoints, [`${txid}.0`]);
		assert.deepEqual(result.errors, [
			{ outpoint: "not-an-outpoint", error: "bad-outpoint" },
		]);
		assert.equal(internalized.length, 1);
		assert.deepEqual(internalized[0].outputs, [
			{
				outputIndex: 0,
				protocol: "basket insertion",
				insertionRemittance: {
					basket: "1sat",
					tags: ["origin:abc"],
					customInstructions: "ci",
				},
			},
		]);
		assert.deepEqual(Beef.fromBinary(internalized[0].tx).atomicTxid, txid);
	});

	it("does nothing when the source basket is empty or the same", async () => {
		const { wallet, internalized } = fakeWallet({
			totalOutputs: 0,
			outputs: [],
		});
		assert.deepEqual(await moveBasketOutputs(wallet, "ordinals", "1sat"), {
			...emptyMove("ordinals", "1sat"),
		});
		assert.deepEqual(
			await moveBasketOutputs(wallet, "1sat", "1sat"),
			emptyMove("1sat", "1sat"),
		);
		assert.equal(internalized.length, 0);
	});
});
