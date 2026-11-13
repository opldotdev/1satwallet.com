import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getBsv21Balances, listLocks } from "@1sat/actions";
import {
	BSOCIAL_BASKET,
	BSV20_BASKET,
	BSV21_BASKET,
	LOCK_BASKET,
	ONESAT_BASKET,
	OPNS_BASKET,
	SIGMA_BASKET,
} from "@1sat/types";
import {
	Beef,
	type ListOutputsArgs,
	type ListOutputsResult,
	LockingScript,
	Transaction,
	type WalletInterface,
	type WalletOutput,
} from "@bsv/sdk";
import {
	createWalletContext,
	HOSTING_BASKET,
	LEGACY_BASKETS,
	legacyBasketsFor,
	listOutputsWithLegacy,
	withLegacyBasketReads,
} from "@/lib/wallet/legacy-baskets";

type Row = WalletOutput & { tx?: Transaction };

function row(basketSeed: number, tags: string[] = []): Row {
	const tx = new Transaction();
	tx.addOutput({
		satoshis: 1,
		lockingScript: LockingScript.fromHex(
			`51${basketSeed.toString(16).padStart(2, "0")}75`,
		),
	});
	return {
		outpoint: `${tx.id("hex")}.0`,
		satoshis: 1,
		spendable: true,
		tags,
		tx,
	};
}

/** In-memory wallet: listOutputs pages each basket like wallet-toolbox. */
function fakeWallet(
	baskets: Record<string, Row[]>,
	options: { refuse?: string[] } = {},
) {
	const calls: ListOutputsArgs[] = [];
	const wallet = {
		listOutputs: async (args: ListOutputsArgs): Promise<ListOutputsResult> => {
			calls.push(args);
			const basket = args.basket ?? "";
			if (options.refuse?.includes(basket)) {
				throw new Error(`basket ${basket} refused`);
			}
			const tags = args.tags ?? [];
			const all = (baskets[basket] ?? []).filter((item) =>
				tags.every((tag) => item.tags?.includes(tag)),
			);
			const offset = args.offset ?? 0;
			const page = all.slice(offset, offset + (args.limit ?? 10));
			let BEEF: number[] | undefined;
			if (args.include === "entire transactions" && page.length > 0) {
				const beef = new Beef();
				for (const item of page) if (item.tx) beef.mergeTransaction(item.tx);
				BEEF = beef.toBinary();
			}
			return {
				totalOutputs: all.length,
				outputs: page.map(({ tx: _tx, ...output }) => output),
				...(BEEF ? { BEEF } : {}),
			};
		},
		getVersion: async () => ({ version: "fake-1.0.0" }),
	} as unknown as WalletInterface;
	return { wallet, calls };
}

const outpoints = (result: { outputs: WalletOutput[] }) =>
	result.outputs.map((output) => output.outpoint);

describe("legacy basket table", () => {
	it("maps each current basket to the legacy names the Swift app reads", () => {
		assert.deepEqual(LEGACY_BASKETS, {
			[ONESAT_BASKET]: ["p 1sat ordinals", "ordinals"],
			[BSV21_BASKET]: ["p 1sat bsv21"],
			[OPNS_BASKET]: ["p 1sat opns"],
			[HOSTING_BASKET]: ["p 1sat hosting"],
			[LOCK_BASKET]: ["p 1sat lock"],
			[SIGMA_BASKET]: ["p 1sat sigma"],
			[BSOCIAL_BASKET]: ["p 1sat bsocial"],
			[BSV20_BASKET]: ["p 1sat bsv20"],
		});
		assert.deepEqual(
			[ONESAT_BASKET, "bsv21", "opns", "hosting", "lock"].map(
				(basket) => legacyBasketsFor(basket).length > 0,
			),
			[true, true, true, true, true],
		);
		assert.deepEqual(legacyBasketsFor("default"), []);
		assert.deepEqual(legacyBasketsFor("p 1sat ordinals"), []);
		assert.deepEqual(legacyBasketsFor("toString"), []);
		assert.deepEqual(legacyBasketsFor(undefined), []);
	});
});

describe("listOutputsWithLegacy", () => {
	it("passes other baskets straight through", async () => {
		const { wallet, calls } = fakeWallet({ default: [row(1)] });
		const result = await listOutputsWithLegacy(wallet, { basket: "default" });
		assert.equal(result.totalOutputs, 1);
		assert.equal(calls.length, 1);
	});

	it("pages the current basket then each legacy basket as one list", async () => {
		const current = [row(1), row(2), row(3)];
		const pBasket = [row(4)];
		const plain = [row(5)];
		const { wallet } = fakeWallet({
			[ONESAT_BASKET]: current,
			"p 1sat ordinals": pBasket,
			ordinals: plain,
		});
		const all = [...current, ...pBasket, ...plain].map((r) => r.outpoint);

		const first = await listOutputsWithLegacy(wallet, {
			basket: ONESAT_BASKET,
			limit: 2,
		});
		assert.deepEqual(outpoints(first), all.slice(0, 2));
		assert.equal(first.totalOutputs, 5);

		const second = await listOutputsWithLegacy(wallet, {
			basket: ONESAT_BASKET,
			limit: 2,
			offset: 2,
		});
		assert.deepEqual(outpoints(second), all.slice(2, 4));

		const third = await listOutputsWithLegacy(wallet, {
			basket: ONESAT_BASKET,
			limit: 2,
			offset: 4,
		});
		assert.deepEqual(outpoints(third), all.slice(4));
		assert.equal(third.totalOutputs, 5);
	});

	it("dedupes by outpoint", async () => {
		const shared = row(7);
		const { wallet } = fakeWallet({
			[ONESAT_BASKET]: [shared],
			"p 1sat ordinals": [shared, row(8)],
			ordinals: [row(9)],
		});
		const result = await listOutputsWithLegacy(wallet, {
			basket: ONESAT_BASKET,
			limit: 100,
		});
		assert.equal(new Set(outpoints(result)).size, result.outputs.length);
		assert.equal(result.outputs.length, 3);
	});

	it("fails the call when a legacy basket read fails", async () => {
		const { wallet } = fakeWallet(
			{ [ONESAT_BASKET]: [row(7)], ordinals: [row(9)] },
			{ refuse: ["ordinals"] },
		);
		await assert.rejects(
			listOutputsWithLegacy(wallet, { basket: ONESAT_BASKET, limit: 100 }),
			/basket ordinals refused/,
		);
	});

	it("reads only the current basket for a negative offset", async () => {
		const { wallet, calls } = fakeWallet({
			[ONESAT_BASKET]: [row(7), row(8)],
			"p 1sat ordinals": [row(9)],
		});
		const result = await listOutputsWithLegacy(wallet, {
			basket: ONESAT_BASKET,
			limit: 1,
			offset: -1,
		});
		assert.deepEqual(
			calls.map((call) => call.basket),
			[ONESAT_BASKET],
		);
		assert.equal(Number(result.totalOutputs), 2);
	});

	it("finds a tagged output by id in a legacy basket (single-row lookups)", async () => {
		const legacy = row(10, ["id:abc"]);
		const { wallet } = fakeWallet({
			[OPNS_BASKET]: [row(11, ["id:other"])],
			"p 1sat opns": [legacy],
		});
		const result = await listOutputsWithLegacy(wallet, {
			basket: OPNS_BASKET,
			tags: ["id:abc"],
			tagQueryMode: "all",
			limit: 1,
		});
		assert.deepEqual(outpoints(result), [legacy.outpoint]);
	});

	it("returns a BEEF covering current and legacy inputs, as send paths request", async () => {
		const current = row(12, ["bsv21:token_0", "amt:1"]);
		const legacy = row(13, ["bsv21:token_0", "amt:2"]);
		const { wallet } = fakeWallet({
			[BSV21_BASKET]: [current],
			"p 1sat bsv21": [legacy],
		});
		const result = await listOutputsWithLegacy(wallet, {
			basket: BSV21_BASKET,
			includeTags: true,
			includeCustomInstructions: true,
			include: "entire transactions",
			limit: 10000,
		});
		assert.deepEqual(outpoints(result), [current.outpoint, legacy.outpoint]);
		assert.ok(result.BEEF);
		const beef = Beef.fromBinary(Array.from(result.BEEF));
		for (const item of [current, legacy]) {
			assert.ok(beef.findTxid(item.outpoint.split(".")[0]));
		}
	});
});

describe("legacy-aware wallet context", () => {
	it("bsv21 balances include a token output still in the legacy basket", async () => {
		const tokenId = `${"ab".repeat(32)}_0`;
		const { wallet } = fakeWallet({
			[BSV21_BASKET]: [row(20, [`bsv21:${tokenId}`, "amt:100", "sym:TST"])],
			"p 1sat bsv21": [row(21, [`bsv21:${tokenId}`, "amt:25", "sym:TST"])],
		});
		const ctx = createWalletContext(wallet, { chain: "main", builtIn: true });
		const balances = await getBsv21Balances.execute(ctx, {});
		assert.equal(balances.length, 1);
		assert.equal(balances[0].id, tokenId);
		assert.equal(balances[0].all.confirmed, 125n);
	});

	it("lock listing includes a lock still in the legacy basket", async () => {
		const legacyLock = row(30, ["until:900000"]);
		const { wallet } = fakeWallet({
			[LOCK_BASKET]: [row(31, ["until:800000"])],
			"p 1sat lock": [legacyLock],
		});
		const ctx = createWalletContext(wallet, { chain: "main", builtIn: true });
		const result = await listLocks.execute(ctx, {});
		assert.equal(result.outputs.length, 2);
		assert.ok(outpoints(result).includes(legacyLock.outpoint));
		assert.equal(result.totalOutputs, 2);
	});

	it("leaves wallets other than the built-in one untouched", async () => {
		const { wallet, calls } = fakeWallet({
			[LOCK_BASKET]: [row(40)],
			"p 1sat lock": [row(41)],
		});
		const ctx = createWalletContext(wallet, { chain: "main", builtIn: false });
		const result = await listLocks.execute(ctx, {});
		assert.equal(result.outputs.length, 1);
		assert.deepEqual(
			calls.map((call) => call.basket),
			[LOCK_BASKET],
		);
		assert.equal(ctx.wallet, wallet);
	});

	it("wraps once and forwards every other wallet method", async () => {
		const { wallet } = fakeWallet({});
		const wrapped = withLegacyBasketReads(wallet);
		assert.equal(withLegacyBasketReads(wrapped), wrapped);
		assert.deepEqual(await wrapped.getVersion({}), {
			version: "fake-1.0.0",
		});
	});
});
