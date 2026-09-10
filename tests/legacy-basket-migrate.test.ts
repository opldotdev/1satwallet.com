import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MoveBasketResult } from "@1sat/actions";
import { LEGACY_P1SAT_BASKET_MIGRATIONS, ONESAT_BASKET } from "@1sat/types";
import type { WalletInterface } from "@bsv/sdk";
import {
	defaultsKey,
	isDue,
	LEFTOVER_ORDINALS_BASKET,
	legacyBasketMigrations,
	mappingVersion,
	migrateIfNeeded,
	migrateLegacyBaskets,
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
	it("adds leftover theme-token ordinals when the published mapping omits it", () => {
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

	it("bumps the mapping version when leftover ordinals is added", () => {
		assert.notEqual(
			mappingVersion(LEGACY_P1SAT_BASKET_MIGRATIONS),
			mappingVersion(legacyBasketMigrations()),
		);
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
