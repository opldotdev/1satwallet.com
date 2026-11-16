import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createContext, type OneSatContext } from "@1sat/actions";
import { OneColor } from "@1sat/templates";
import {
	type ActionStatus,
	LockingScript,
	Transaction,
	type WalletInterface,
} from "@bsv/sdk";
import { sdk } from "@bsv/wallet-toolbox-client";
import {
	isOneColorQueryEnabled,
	oneColorBalancesQueryKey,
} from "@/hooks/use-one-color-balances";
import { isRouteAvailableOn, walletTabsFor } from "@/lib/chain-surfaces";
import {
	aggregateOneColorHoldings,
	assetInfoFromMetadata,
	decodeOneColor,
	findSpendingStatuses,
	getOneColorAssetInfo,
	getOneColorBalances,
	listOneColorHoldings,
	oneColorTicker,
	pendingAmount,
} from "@/lib/wallet/one-color";

// Transactions from the SDK's packages/templates/src/1color/testdata
// (amm-poc programs/amm-topic/src/fixtures/vectors.zig).
const fixture = (name: string) =>
	Transaction.fromHex(
		readFileSync(
			new URL(`./fixtures/one-color/${name}.hex`, import.meta.url),
			"utf8",
		).trim(),
	);

const ASSET = `${"ab".repeat(32)}_0`;
const OTHER = `${"cd".repeat(32)}_0`;
const DEPLOY_TXID = "ab".repeat(32);
const pkh = new Array(20).fill(7);
const P2PKH = `76a914${"00".repeat(20)}88ac`;
const value = (assetId: string, amount: bigint) =>
	OneColor.value(assetId, amount, { lock: pkh }).lock().toHex();
const authority = (assetId: string) =>
	OneColor.authority(assetId, { lock: pkh }).lock().toHex();

describe("aggregateOneColorHoldings", () => {
	it("sums available value by asset, lists reserved outputs, and counts authorities", () => {
		const held = aggregateOneColorHoldings([
			{ outpoint: "a.0", lockingScript: value(ASSET, 100n), spendable: true },
			{ outpoint: "b.0", lockingScript: value(ASSET, 25n), spendable: false },
			{ outpoint: "c.0", lockingScript: value(ASSET, 5n), spendable: true },
			{ outpoint: "d.0", lockingScript: authority(ASSET), spendable: true },
			{ outpoint: "e.0", lockingScript: value(OTHER, 1n), spendable: true },
		]);
		assert.deepEqual(held.get(ASSET), {
			assetId: ASSET,
			available: 105n,
			reservedOutputs: [{ outpoint: "b.0", amount: 25n }],
			authorities: 1,
		});
		assert.deepEqual(held.get(OTHER), {
			assetId: OTHER,
			available: 1n,
			reservedOutputs: [],
			authorities: 0,
		});
	});

	it("counts reserved authorities too, and a holder of only an authority gets an entry", () => {
		const held = aggregateOneColorHoldings([
			{ outpoint: "a.0", lockingScript: authority(ASSET), spendable: false },
			{ outpoint: "b.0", lockingScript: authority(ASSET), spendable: true },
		]);
		assert.deepEqual(held.get(ASSET), {
			assetId: ASSET,
			available: 0n,
			reservedOutputs: [],
			authorities: 2,
		});
	});

	it("a fixed-supply deploy (SDK token_deploy fixture) is the asset's first value output, keyed <txid>_0", () => {
		const tx = fixture("token_deploy");
		const txid = tx.id("hex");
		const held = aggregateOneColorHoldings([
			{
				outpoint: `${txid}.0`,
				lockingScript: tx.outputs[0].lockingScript.toHex(),
				spendable: true,
			},
			{
				outpoint: "b.0",
				lockingScript: value(`${txid}_0`, 5n),
				spendable: true,
			},
		]);
		assert.deepEqual(held.get(`${txid}_0`), {
			assetId: `${txid}_0`,
			available: 10_000_005n,
			reservedOutputs: [],
			authorities: 0,
		});
	});

	it("an authority deploy counts as the asset's first authority", () => {
		const deploy = OneColor.deployAuthority({ lock: pkh }).lock().toHex();
		const held = aggregateOneColorHoldings([
			{
				outpoint: `${DEPLOY_TXID}.0`,
				lockingScript: deploy,
				spendable: true,
			},
		]);
		assert.deepEqual(held.get(`${DEPLOY_TXID}_0`), {
			assetId: `${DEPLOY_TXID}_0`,
			available: 0n,
			reservedOutputs: [],
			authorities: 1,
		});
	});

	it("a deploy that is not output 0 is no asset (BRC-162, color module, iOS)", () => {
		const deploy = OneColor.deployValue(10n, { lock: pkh }).lock().toHex();
		const held = aggregateOneColorHoldings([
			{
				outpoint: `${DEPLOY_TXID}.1`,
				lockingScript: deploy,
				spendable: true,
			},
		]);
		assert.equal(held.size, 0);
	});

	it("a BRC-161 token migrated with a 36-byte id (SDK legacy_migrate1 fixture) is keyed <txid>_1", () => {
		const assetId = `${fixture("legacy_deploy1").id("hex")}_1`;
		const migrate = fixture("legacy_migrate1");
		const held = aggregateOneColorHoldings([
			{
				outpoint: `${migrate.id("hex")}.0`,
				lockingScript: migrate.outputs[0].lockingScript.toHex(),
				spendable: true,
			},
		]);
		assert.deepEqual([...held.keys()], [assetId]);
		assert.equal(held.get(assetId)?.available, 500_000n);
	});

	it("skips non-token scripts, bad hex, missing scripts and BRC-161 JSON inscriptions", () => {
		const transfer = fixture("legacy_transfer");
		const held = aggregateOneColorHoldings([
			{ outpoint: "b.0", lockingScript: P2PKH, spendable: true },
			{ outpoint: "c.0", lockingScript: "zz", spendable: true },
			{ outpoint: "d.0", spendable: true },
			...transfer.outputs.map((o, i) => ({
				outpoint: `${transfer.id("hex")}.${i}`,
				lockingScript: o.lockingScript.toHex(),
				spendable: true,
			})),
		]);
		assert.equal(held.size, 0);
		assert.equal(decodeOneColor("zz"), null);
		assert.equal(decodeOneColor(undefined), null);
	});
});

describe("listOneColorHoldings", () => {
	it("reads the basket-prefix listing once, locking scripts only, and keeps each output's spendability", async () => {
		const calls: Record<string, unknown>[] = [];
		const all = Array.from({ length: 1203 }, (_, i) => ({
			outpoint: `${i.toString(16).padStart(64, "0")}.0`,
			satoshis: 1,
			spendable: i % 7 !== 0,
			lockingScript: value(`${DEPLOY_TXID}_0`, 1n),
		}));
		const wallet = {
			// As the toolbox answers this listing: every output, whatever page is asked for.
			listOutputs: async (args: Record<string, unknown>) => {
				calls.push(args);
				return { totalOutputs: all.length, outputs: all };
			},
		} as unknown as Pick<WalletInterface, "listOutputs">;
		const held = await listOneColorHoldings(wallet);
		assert.deepEqual(calls, [
			{
				basket: sdk.specOpBasketPrefixOutputs,
				tags: ["p color"],
				include: "locking scripts",
				limit: 10_000,
			},
		]);
		assert.equal(held.length, 1203);
		assert.deepEqual(held[0], {
			outpoint: all[0].outpoint,
			lockingScript: all[0].lockingScript,
			spendable: false,
		});
		assert.equal(held[1].spendable, true);
	});
});

describe("assetInfoFromMetadata", () => {
	it("no metadata: zero decimals, nothing else", () => {
		assert.deepEqual(assetInfoFromMetadata(undefined), { dec: 0 });
	});

	it("symbol, decimals and an image icon as a data URL", () => {
		assert.deepEqual(
			assetInfoFromMetadata({
				sym: "TKN",
				dec: 2,
				icon: { mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) },
			}),
			{ sym: "TKN", dec: 2, icon: "data:image/png;base64,AQID" },
		);
	});

	it("a non-image icon is left out", () => {
		assert.deepEqual(
			assetInfoFromMetadata({
				icon: { mediaType: "text/plain", bytes: new Uint8Array([1]) },
			}),
			{ dec: 0 },
		);
	});

	it("the ticker is the symbol, else a short asset id", () => {
		assert.equal(oneColorTicker({ sym: "GLD", assetId: ASSET }), "GLD");
		assert.equal(oneColorTicker({ assetId: ASSET }), "ababab…ab_0");
	});
});

describe("reserved outputs: pending versus spent", () => {
	type Spend = { txid: string; status: ActionStatus; inputs: string[] };
	/** A wallet whose history is `spends`, oldest first, answering the newest-first paging. */
	const walletWith = (spends: Spend[], pageLog: number[] = []) =>
		({
			listActions: async (args: {
				limit?: number;
				offset?: number;
				includeInputs?: boolean;
			}) => {
				const offset = args.offset ?? 0;
				const limit = args.limit ?? 10;
				pageLog.push(limit);
				return {
					totalActions: spends.length,
					actions: spends.slice(offset, offset + limit).map((s) => ({
						txid: s.txid,
						satoshis: 0,
						status: s.status,
						isOutgoing: true,
						description: "",
						version: 1,
						lockTime: 0,
						inputs: args.includeInputs
							? s.inputs.map((o) => ({
									sourceOutpoint: o,
									sourceSatoshis: 1,
									inputDescription: "",
									sequenceNumber: 0,
								}))
							: undefined,
					})),
				};
			},
		}) as unknown as Pick<WalletInterface, "listActions">;

	it("counts nosend, unsigned, nonfinal and unknown spenders; skips unproven and sending", async () => {
		const wallet = walletWith([
			{ txid: "old", status: "completed", inputs: ["x.0"] },
			{ txid: "split", status: "unproven", inputs: ["big.0"] },
			{ txid: "posting", status: "sending", inputs: ["out.0"] },
			{ txid: "draft", status: "unsigned", inputs: ["u.0"] },
			{ txid: "locked", status: "nonfinal", inputs: ["n.0"] },
			{ txid: "handoff", status: "nosend", inputs: ["split.0"] },
		]);
		const reserved = [
			{ outpoint: "big.0", amount: 10_000n },
			{ outpoint: "out.0", amount: 300n },
			{ outpoint: "u.0", amount: 20n },
			{ outpoint: "n.0", amount: 40n },
			{ outpoint: "split.0", amount: 1_000n },
			{ outpoint: "older.0", amount: 7n },
		];
		const statuses = await findSpendingStatuses(
			wallet,
			reserved.map((r) => r.outpoint),
		);
		assert.equal(statuses.get("big.0"), "unproven");
		assert.equal(statuses.get("out.0"), "sending");
		assert.equal(statuses.get("split.0"), "nosend");
		assert.equal(statuses.has("older.0"), false);
		assert.equal(pendingAmount(reserved, statuses), 1_067n);
	});

	it("scans newest first and stops once every outpoint is found", async () => {
		const spends: Spend[] = [];
		for (let i = 0; i < 250; i++)
			spends.push({ txid: `t${i}`, status: "completed", inputs: [`t${i}.0`] });
		spends.push({ txid: "h", status: "nosend", inputs: ["want.0"] });
		const pages: number[] = [];
		const statuses = await findSpendingStatuses(walletWith(spends, pages), [
			"want.0",
		]);
		assert.equal(statuses.get("want.0"), "nosend");
		// One probe of 1, then a single page of 100 from the newest end.
		assert.deepEqual(pages, [1, 100]);
	});

	it("stops after 2000 actions when an outpoint is never found", async () => {
		const spends: Spend[] = Array.from({ length: 2500 }, (_, i) => ({
			txid: `t${i}`,
			status: "completed" as const,
			inputs: [`t${i}.0`],
		}));
		const pages: number[] = [];
		await findSpendingStatuses(walletWith(spends, pages), ["gone.0"]);
		assert.deepEqual(pages, [1, ...new Array(20).fill(100)]);
	});

	it("nothing reserved means no history read at all", async () => {
		const pages: number[] = [];
		assert.equal(
			(await findSpendingStatuses(walletWith([], pages), [])).size,
			0,
		);
		assert.deepEqual(pages, []);
	});
});

/**
 * A deploy transaction carrying display fields, and its asset id. Each test
 * uses its own symbol: asset info is cached per asset for the module's life.
 */
const deployWithMetadata = (sym: string) => {
	const tx = new Transaction();
	tx.addOutput({
		satoshis: 1,
		lockingScript: OneColor.deployValue(1_000n, {
			lock: pkh,
			payload: {
				sym,
				dec: 2,
				icon: { mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) },
			},
		}).lock(),
	});
	return { tx, assetId: `${tx.id("hex")}_0` };
};

/** Services whose BEEF client answers `getRawTx` from `rawTx`, counting calls. */
const servicesWith = (rawTx: (txid: string) => Promise<Uint8Array>) => {
	const calls: string[] = [];
	const services = {
		beef: {
			getRawTx: async (txid: string) => {
				calls.push(txid);
				return rawTx(txid);
			},
		},
	} as unknown as NonNullable<OneSatContext["services"]>;
	return { services, calls };
};

describe("getOneColorAssetInfo", () => {
	it("reads symbol, decimals and icon from the deploy once per asset", async () => {
		const { tx, assetId } = deployWithMetadata("GLD");
		const { services, calls } = servicesWith(async () =>
			Uint8Array.from(tx.toBinary()),
		);
		const ctx = { chain: "test" as const, services };
		const expected = { sym: "GLD", dec: 2, icon: "data:image/png;base64,AQID" };
		assert.deepEqual(await getOneColorAssetInfo(ctx, assetId), expected);
		assert.deepEqual(await getOneColorAssetInfo(ctx, assetId), expected);
		assert.deepEqual(calls, [tx.id("hex")]);
	});

	it("a deploy without display fields (SDK token_deploy fixture) has 0 decimals and no symbol", async () => {
		const tx = fixture("token_deploy");
		const { services } = servicesWith(async () =>
			Uint8Array.from(tx.toBinary()),
		);
		assert.deepEqual(
			await getOneColorAssetInfo(
				{ chain: "test", services },
				`${tx.id("hex")}_0`,
			),
			{ dec: 0 },
		);
	});

	it("rejects an output that is not a deploy, and a bad asset id", async () => {
		const tx = new Transaction();
		tx.addOutput({ satoshis: 1, lockingScript: LockingScript.fromHex(P2PKH) });
		const { services } = servicesWith(async () =>
			Uint8Array.from(tx.toBinary()),
		);
		await assert.rejects(
			getOneColorAssetInfo({ chain: "test", services }, `${tx.id("hex")}_0`),
			/not a 1Color deploy/,
		);
		await assert.rejects(
			getOneColorAssetInfo({ chain: "test", services }, "nope_0"),
			/not a 1Color asset id/,
		);
	});
});

describe("getOneColorBalances", () => {
	it("a deploy that cannot be read yields a placeholder { dec: 0 } marked unreadable, retried on the next read", async () => {
		const { tx, assetId } = deployWithMetadata("SLV");
		let online = false;
		const { services, calls } = servicesWith(async () => {
			if (!online) throw new Error("beef service down");
			return Uint8Array.from(tx.toBinary());
		});
		const wallet = {
			listOutputs: async () => ({
				totalOutputs: 3,
				outputs: [
					{
						outpoint: "a.0",
						lockingScript: value(assetId, 40n),
						spendable: true,
					},
					{
						outpoint: "b.0",
						lockingScript: value(assetId, 9n),
						spendable: false,
					},
					{
						outpoint: "c.0",
						lockingScript: authority(assetId),
						spendable: true,
					},
				],
			}),
			listActions: async (args: { includeInputs?: boolean }) => ({
				totalActions: 1,
				actions: [
					{
						txid: "handoff",
						status: "nosend",
						inputs: args.includeInputs
							? [{ sourceOutpoint: "b.0" }]
							: undefined,
					},
				],
			}),
		} as unknown as WalletInterface;
		const ctx = createContext(wallet, { services, chain: "test" });
		const originalError = console.error;
		const logged: unknown[][] = [];
		console.error = (...args: unknown[]) => logged.push(args);
		try {
			assert.deepEqual(await getOneColorBalances(ctx), [
				{
					assetId,
					available: 40n,
					pending: 9n,
					authorities: 1,
					dec: 0,
					infoUnreadable: true,
				},
			]);
		} finally {
			console.error = originalError;
		}
		assert.ok(
			logged.some((args) => String(args[0]).includes(assetId)),
			"the unreadable deploy is logged with its asset id",
		);
		online = true;
		assert.deepEqual(await getOneColorBalances(ctx), [
			{
				assetId,
				available: 40n,
				pending: 9n,
				authorities: 1,
				sym: "SLV",
				dec: 2,
				icon: "data:image/png;base64,AQID",
			},
		]);
		assert.equal(calls.length, 2);
	});
});

describe("1Color surfaces per chain", () => {
	it("the holdings query runs only on testnet, for the built-in wallet", () => {
		const ready = {
			chain: "test" as const,
			connectionMode: "built-in" as const,
			hasWallet: true,
			identityKey: "02ab",
		};
		assert.equal(isOneColorQueryEnabled(ready), true);
		assert.equal(isOneColorQueryEnabled({ ...ready, chain: "main" }), false);
		assert.equal(
			isOneColorQueryEnabled({ ...ready, connectionMode: "external" }),
			false,
		);
		assert.equal(
			isOneColorQueryEnabled({ ...ready, connectionMode: "none" }),
			false,
		);
		assert.equal(isOneColorQueryEnabled({ ...ready, hasWallet: false }), false);
		assert.equal(
			isOneColorQueryEnabled({ ...ready, identityKey: null }),
			false,
		);
		assert.deepEqual(oneColorBalancesQueryKey("test", "02ab"), [
			"one-color",
			"test",
			"02ab",
		]);
	});

	it("the 1Color tab and route exist on testnet only", () => {
		assert.ok(walletTabsFor("test").some((tab) => tab.value === "1color"));
		assert.ok(!walletTabsFor("main").some((tab) => tab.value === "1color"));
		assert.equal(isRouteAvailableOn("test", "/wallet/1color"), true);
		assert.equal(isRouteAvailableOn("main", "/wallet/1color"), false);
		assert.equal(isRouteAvailableOn("main", "/wallet/1color/abc_0"), false);
		assert.equal(isRouteAvailableOn("main", "/wallet/1colorx"), true);
	});

	it("an external wallet's 1Color holdings read as managed by that wallet", () => {
		const grid = readFileSync(
			new URL("../components/wallet/one-color-grid.tsx", import.meta.url),
			"utf8",
		);
		assert.match(grid, /connectionMode === "external"/);
		assert.match(grid, /capability: "provider-managed"/);
		assert.match(grid, /describeAssetSurface\(/);
	});
});
