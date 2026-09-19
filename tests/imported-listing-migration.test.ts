import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { afterEach, mock, test } from "node:test";
import { createContext, scanAddress, sweepOrdinals } from "@1sat/actions";
import { OneSatServices } from "@1sat/client";
import type { IndexedOutput } from "@1sat/types";
import {
	Beef,
	P2PKH,
	PrivateKey,
	Transaction,
	type WalletInterface,
} from "@bsv/sdk";
import { legacyScanInventory } from "@/lib/hooks/use-legacy-assets";
import {
	executeMigrationSweep,
	type MigrationSweepParams,
	type SweepResult,
} from "@/lib/sweep-migration";
import {
	defaultAssetTypes,
	delistMigrationListings,
	executeMigrationPlan,
	listedFromLegacy,
	planMigration,
	plannedCount,
} from "@/lib/wallet/migration-listings";
import { legacyMigrationKeys } from "@/lib/wallet-migration";

const payKey = PrivateKey.fromHex("1");
const ordKey = PrivateKey.fromHex("2");
const identityKey = PrivateKey.fromHex("3");
const wallet = {} as WalletInterface;
const ctx = createContext(wallet);
afterEach(() => mock.restoreAll());

async function serve(respond: (url: URL) => string) {
	const server = createServer((request, response) => {
		response.end(respond(new URL(request.url ?? "/", "http://127.0.0.1")));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Test server address unavailable");
	return {
		origin: `http://127.0.0.1:${address.port}`,
		async close() {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}

function listing(n = "ab", key = ordKey): IndexedOutput {
	return {
		outpoint: `${n.repeat(32)}.0`,
		score: 0,
		satoshis: 1,
		events: [`own:${key.toAddress()}`, "type:application/op-ns"],
		data: {
			ordlock: {
				seller: key.toAddress(),
				price: 1000,
				pricePer: 0,
				payout: "",
			},
		},
	};
}
const params: Omit<
	MigrationSweepParams,
	"funding" | "ordinals" | "bsv21Tokens" | "mneeBalance"
> = {
	wallet,
	services: {} as OneSatServices,
	legacyPayWif: payKey.toWif(),
	legacyOrdWif: ordKey.toWif(),
	legacyIdentityWif: identityKey.toWif(),
	onProgress: () => {},
};
function receipt(
	ordinalTxids: string[] = [],
	errors: string[] = [],
): SweepResult {
	return { bsvTxids: [], ordinalTxids, bsv21Txids: [], errors };
}
function makePlan(
	listed: IndexedOutput[],
	funding: IndexedOutput[] = [],
	types = defaultAssetTypes(),
) {
	return planMigration({
		types,
		listings: listedFromLegacy(listed),
		listedLegacyOutputs: listed,
		ordinals: [],
		opns: [],
		funding,
		bsv21: [],
		mneeBalance: 0,
	});
}
const funding: IndexedOutput = {
	outpoint: `${"cd".repeat(32)}.0`,
	score: 0,
	satoshis: 10000,
	events: [`own:${payKey.toAddress()}`],
};

test("published scanner preserves data-only listings through the hook and migrated-account plan", async () => {
	const row = listing();
	const requests: URL[] = [];
	const server = await serve((url) => {
		requests.push(url);
		if (url.pathname.endsWith("/txos")) return "event: done\ndata: {}\n\n";
		return JSON.stringify([
			{
				...row,
				data: url.searchParams.get("tags") === "ordlock" ? row.data : undefined,
			},
		]);
	});
	const services = new OneSatServices("main", server.origin);
	try {
		const scanned = await scanAddress(services, ordKey.toAddress());
		const assets = legacyScanInventory(scanned);
		assert.deepEqual(
			assets.listings.map((output) => output.outpoint),
			[row.outpoint],
		);
		assert.deepEqual(assets.ordinals, []);
		assert.deepEqual(assets.opnsNames, []);
		assert.equal(
			requests[1].searchParams.get("key"),
			`own:${ordKey.toAddress()}`,
		);
		assert.equal(requests[1].searchParams.get("tags"), "ordlock");
		assert.equal(requests[1].searchParams.get("limit"), "0");
		const legacy = legacyMigrationKeys({
			status: "migrated",
			legacyPayWif: params.legacyPayWif,
			legacyOrdWif: params.legacyOrdWif,
			legacyIdentityWif: params.legacyIdentityWif,
			legacyPayAddress: payKey.toAddress(),
			legacyOrdAddress: ordKey.toAddress(),
			legacyIdentityAddress: identityKey.toAddress(),
		});
		assert.equal(legacy?.sweepOnly, true);
		assert.equal(legacy?.ordAddress, ordKey.toAddress());
		assert.equal(legacy?.identityWif, params.legacyIdentityWif);
		assert.equal(plannedCount(makePlan(assets.listings)), 1);
	} finally {
		services.close();
		await server.close();
	}
});

for (const stream of [
	"event: sync\ndata: {}\n\n",
	"event: error\ndata: scan failed\n\n",
]) {
	test("incomplete native owner sync cannot become an empty successful migration", async () => {
		let calls = 0;
		const server = await serve(() => {
			calls++;
			return stream;
		});
		const services = new OneSatServices("main", server.origin);
		try {
			await assert.rejects(scanAddress(services, ordKey.toAddress()));
			assert.equal(calls, 1);
		} finally {
			services.close();
			await server.close();
		}
	});
}

test("mixed holdings produce no duplicate listing or sweep inputs across categories", () => {
	const row = listing();
	const plain: IndexedOutput = {
		...listing("ac"),
		data: undefined,
		events: ["type:image/png"],
	};
	const plan = planMigration({
		types: defaultAssetTypes(),
		listings: listedFromLegacy([row, row]),
		listedLegacyOutputs: [row, row],
		ordinals: [row, plain, plain],
		opns: [plain],
		funding: [funding, funding],
		bsv21: [],
		mneeBalance: 0,
	});
	assert.deepEqual(plan.sweepListed, [row]);
	assert.deepEqual(plan.sweepOrdinals, [plain]);
	assert.deepEqual(plan.sweepFunding, [funding]);
	assert.equal(plannedCount(plan), 3);
});

test("full migration cancels imported listings before funding and retains receipts", async () => {
	const rows = [listing(), listing("ac", identityKey)];
	const calls: string[][] = [];
	const result = await executeMigrationPlan(
		{
			ctx,
			plan: makePlan(rows, [funding]),
			listings: listedFromLegacy(rows),
			legacyOutputs: rows,
			sweepParams: params,
			mneeBalance: 0,
		},
		undefined,
		async (request) => {
			calls.push(
				[...request.ordinals, ...request.funding].map(
					(output) => output.outpoint,
				),
			);
			return request.funding.length
				? { ...receipt(), bsvTxids: ["funded"] }
				: receipt([`cancel-${calls.length}`]);
		},
	);
	assert.deepEqual(calls, [
		[rows[0].outpoint],
		[rows[1].outpoint],
		[funding.outpoint],
	]);
	assert.deepEqual(
		result.completedOutpoints,
		rows.map((row) => row.outpoint),
	);
	assert.deepEqual(result.ordinalTxids, ["cancel-1", "cancel-2"]);
	assert.deepEqual(result.bsvTxids, ["funded"]);
});

test("partial cancellation failure blocks funding; retry skips confirmed listings", async () => {
	const rows = [listing(), listing("ac")];
	let failing = true;
	const calls: string[] = [];
	const sweep = async (request: MigrationSweepParams): Promise<SweepResult> => {
		const output = request.ordinals[0] ?? request.funding[0];
		calls.push(output.outpoint);
		if (failing && output.outpoint === rows[1].outpoint)
			return receipt([], ["Approval declined"]);
		return request.funding.length
			? { ...receipt(), bsvTxids: ["funded"] }
			: receipt([output.outpoint]);
	};
	const first = await executeMigrationPlan(
		{
			ctx,
			plan: makePlan(rows, [funding]),
			listings: listedFromLegacy(rows),
			legacyOutputs: rows,
			sweepParams: params,
			mneeBalance: 0,
		},
		undefined,
		sweep,
	);
	assert.deepEqual(first.completedOutpoints, [rows[0].outpoint]);
	assert.deepEqual(first.errors, ["Approval declined"]);
	assert.ok(!calls.includes(funding.outpoint));
	failing = false;
	const remaining = rows.filter(
		(row) => !first.completedOutpoints.includes(row.outpoint),
	);
	const second = await executeMigrationPlan(
		{
			ctx,
			plan: makePlan(remaining, [funding]),
			listings: listedFromLegacy(remaining),
			legacyOutputs: remaining,
			sweepParams: params,
			mneeBalance: 0,
		},
		undefined,
		sweep,
	);
	assert.deepEqual(second.errors, []);
	assert.deepEqual(calls, [
		rows[0].outpoint,
		rows[1].outpoint,
		rows[1].outpoint,
		funding.outpoint,
	]);
});

test("missing cancellation txid and deselected listings both block the funding sweep", async () => {
	const rows = [listing()];
	for (const types of [defaultAssetTypes(), new Set<"bsv">(["bsv"])]) {
		let fundingCalls = 0;
		const result = await executeMigrationPlan(
			{
				ctx,
				plan: makePlan(rows, [funding], types),
				listings: listedFromLegacy(rows),
				legacyOutputs: rows,
				sweepParams: params,
				mneeBalance: 0,
			},
			undefined,
			async (request) => {
				fundingCalls += request.funding.length;
				return receipt();
			},
		);
		assert.ok(result.errors.length > 0);
		assert.deepEqual(result.completedOutpoints, []);
		assert.equal(fundingCalls, 0);
	}
});

test("a later funding exception retains completed cancellation receipts", async () => {
	const rows = [listing()];
	const result = await executeMigrationPlan(
		{
			ctx,
			plan: makePlan(rows, [funding]),
			listings: listedFromLegacy(rows),
			legacyOutputs: rows,
			sweepParams: params,
			mneeBalance: 0,
		},
		undefined,
		async (request) => {
			if (request.funding.length) throw new Error("Funding unavailable");
			return receipt(["cancelled"]);
		},
	);
	assert.deepEqual(result.completedOutpoints, [rows[0].outpoint]);
	assert.deepEqual(result.ordinalTxids, ["cancelled"]);
	assert.deepEqual(result.errors, ["Funding unavailable"]);
});

test("delist-only includes data-only listings when all asset checkboxes are off", async () => {
	const rows = [listing()];
	assert.equal(plannedCount(makePlan(rows, [], new Set())), 0);
	const result = await delistMigrationListings(
		{
			ctx,
			listings: listedFromLegacy(rows),
			legacyOutputs: rows,
			sweepParams: params,
		},
		undefined,
		async (request) => {
			assert.deepEqual(request.ordinals, rows);
			assert.deepEqual(request.funding, []);
			return receipt(["cancelled"]);
		},
	);
	assert.deepEqual(result.completedOutpoints, [rows[0].outpoint]);
});

function sourceFixture() {
	const a = new Transaction();
	a.addOutput({
		satoshis: 1,
		lockingScript: new P2PKH().lock(payKey.toAddress()),
	});
	a.addOutput({
		satoshis: 1,
		lockingScript: new P2PKH().lock(identityKey.toAddress()),
	});
	const b = new Transaction();
	b.addOutput({
		satoshis: 1,
		lockingScript: new P2PKH().lock(ordKey.toAddress()),
	});
	const sources = new Map([a, b].map((source) => [source.id("hex"), source]));
	const rows = [
		[a, 0, payKey],
		[b, 0, ordKey],
		[a, 1, identityKey],
	].map(([source, vout, key]) => ({
		outpoint: `${(source as Transaction).id("hex")}.${vout}`,
		score: 0,
		satoshis: 1,
		events: [`own:${(key as PrivateKey).toAddress()}`],
	}));
	const services = {
		async getBeefForTxid(txid: string) {
			const beef = new Beef();
			beef.mergeTransaction(sources.get(txid) as Transaction);
			return beef;
		},
	} as OneSatServices;
	return { rows, services };
}

test("native input preparation preserves matching keys for interleaved transaction outputs", async () => {
	const { rows, services } = sourceFixture();
	const ownerByOutpoint = new Map(
		rows.map((row) => [row.outpoint, row.events[0].slice(4)]),
	);
	const execute = mock.method(
		sweepOrdinals,
		"execute",
		async (...[_context, input]: Parameters<typeof sweepOrdinals.execute>) => {
			assert.equal(input.inputs.length, 3);
			input.inputs.forEach((prepared, index) => {
				assert.equal(
					input.keys[index].toAddress(),
					ownerByOutpoint.get(prepared.outpoint),
				);
			});
			return { txid: "native-sweep" };
		},
	);
	const result = await executeMigrationSweep({
		...params,
		services,
		funding: [],
		ordinals: rows,
		bsv21Tokens: [],
	});
	assert.deepEqual(result.errors, []);
	assert.deepEqual(result.ordinalTxids, ["native-sweep"]);
	assert.equal(execute.mock.callCount(), 1);
});

test("native sweep reports a missing txid and refuses outputs without a matching owner key", async () => {
	const { rows, services } = sourceFixture();
	const execute = mock.method(sweepOrdinals, "execute", async () => ({}));
	const result = await executeMigrationSweep({
		...params,
		services,
		funding: [],
		ordinals: rows,
		bsv21Tokens: [],
	});
	assert.ok(result.errors.join(" ").includes("no transaction ID"));
	const wrongOwner = { ...rows[0], events: ["own:unavailable-owner"] };
	const refused = await executeMigrationSweep({
		...params,
		services,
		funding: [],
		ordinals: [wrongOwner],
		bsv21Tokens: [],
	});
	assert.ok(refused.errors.join(" ").includes("No key for output"));
	assert.equal(execute.mock.callCount(), 1);
});

test("both migration entrypoints retain scanner listings and use the funding gate", () => {
	for (const path of [
		"app/(main)/wallet/migrate/page.tsx",
		"components/wallet/migration-wizard.tsx",
	]) {
		const source = readFileSync(path, "utf8");
		assert.ok(source.includes("...assets.listings"));
		assert.ok(source.includes("await executeMigrationPlan("));
		assert.ok(source.includes("legacyMigrationKeys(migrationStatus)"));
	}
	assert.ok(
		readFileSync("components/wallet/legacy-sweep-banner.tsx", "utf8").includes(
			"listings.length +",
		),
	);
});
