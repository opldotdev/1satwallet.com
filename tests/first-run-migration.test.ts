import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { OneSatContext } from "@1sat/actions";
import type { OneSatServices } from "@1sat/client";
import { wifToHex } from "@1sat/utils";
import { PrivateKey, type WalletInterface } from "@bsv/sdk";
import { emptySweepResult } from "@/lib/sweep-migration";
import {
	type MigrationTarget,
	requireMigrationTarget,
	runFirstRunMigration,
	runMigrationOnTarget,
} from "@/lib/wallet/first-run-migration";
import type { ListedAsset } from "@/lib/wallet/migration-listings";

const identityKey = PrivateKey.fromHex("03".repeat(32));
const identityWif = identityKey.toWif();
const payKey = PrivateKey.fromHex("01".repeat(32));

function fakeTarget(rootKey: PrivateKey, name: string): MigrationTarget {
	const wallet = {
		name,
		getPublicKey: async () => ({
			publicKey: rootKey.toPublicKey().toString(),
		}),
	} as unknown as WalletInterface;
	return {
		wallet,
		services: { name } as unknown as OneSatServices,
		oneSatContext: { wallet, name } as unknown as OneSatContext,
	};
}

const listing: ListedAsset = {
	outpoint: `${"aa".repeat(32)}.0`,
	id: "asset-1",
	source: "wallet",
};

function harness(
	init: (rootKeyHex: string) => Promise<MigrationTarget | null>,
) {
	const legacy = fakeTarget(payKey, "pay-key wallet");
	const log: string[] = [];
	const swept: MigrationTarget[] = [];
	const cancelledOn: OneSatContext[] = [];
	const deps = {
		current: legacy,
		listings: [listing],
		identityWif,
		isInitialized: true,
		settleMs: 0,
		destroyWallet: async () => {
			log.push("destroy");
		},
		initializeWallet: async (rootKeyHex: string) => {
			log.push("init");
			return init(rootKeyHex);
		},
		persistIdentity: async () => {
			log.push("persist");
		},
		cancelListings: async (ctx: OneSatContext) => {
			log.push("cancel");
			cancelledOn.push(ctx);
			return { ok: true, txids: ["cancel-1"], errors: [] };
		},
		sweep: async (target: MigrationTarget) => {
			log.push("sweep");
			swept.push(target);
			return emptySweepResult({ bsvTxids: ["bsv-1"] });
		},
	};
	return { deps, legacy, log, swept, cancelledOn };
}

describe("first-run migration re-root", () => {
	it("sweeps into the wallet initializeWallet returned, never the destroyed one", async () => {
		const fresh = fakeTarget(identityKey, "identity wallet");
		let rootSeen = "";
		const { deps, legacy, log, swept, cancelledOn } = harness(async (hex) => {
			rootSeen = hex;
			return fresh;
		});

		const run = await runFirstRunMigration(deps);

		assert.equal(rootSeen, wifToHex(identityWif));
		assert.deepEqual(log, ["cancel", "persist", "destroy", "init", "sweep"]);
		// The wallet's own listings belong to the running wallet: cancelled
		// there, before anything is changed.
		assert.equal(cancelledOn[0], legacy.oneSatContext);
		assert.equal(swept.length, 1);
		assert.equal(swept[0], fresh);
		assert.notEqual(swept[0].wallet, legacy.wallet);
		assert.notEqual(swept[0].services, legacy.services);
		assert.deepEqual(run.cancelTxids, ["cancel-1"]);
		assert.deepEqual(run.sweep?.bsvTxids, ["bsv-1"]);
	});

	it("throws, and sweeps nothing, when the wallet does not reopen", async () => {
		const { deps, swept } = harness(async () => null);
		await assert.rejects(
			runFirstRunMigration(deps),
			/Failed to initialize wallet with identity key/,
		);
		assert.equal(swept.length, 0);
	});

	it("throws when the reopened wallet is not rooted at the identity key", async () => {
		const { deps, swept } = harness(async () =>
			fakeTarget(payKey, "still the pay-key wallet"),
		);
		await assert.rejects(
			runFirstRunMigration(deps),
			/not rooted at the identity key/,
		);
		assert.equal(swept.length, 0);
	});

	it("stops before changing anything when a listing cannot be cancelled", async () => {
		const { deps, log } = harness(async () =>
			fakeTarget(identityKey, "identity wallet"),
		);
		const failing = {
			...deps,
			cancelListings: async () => ({
				ok: false,
				txids: [],
				errors: ["Listing x: declined"],
			}),
		};
		await assert.rejects(runFirstRunMigration(failing), (error: Error) => {
			assert.match(error.message, /Listings must be cancelled/);
			assert.deepEqual(error.cause, ["Listing x: declined"]);
			return true;
		});
		assert.deepEqual(log, []);
	});

	it("refuses to run a step on a wallet that is not open", () => {
		assert.throws(
			() =>
				requireMigrationTarget({
					wallet: null,
					services: null,
					oneSatContext: null,
				}),
			/not initialized/,
		);
	});

	it("runs a sweep-only re-entry on the running wallet", async () => {
		const live = fakeTarget(identityKey, "identity wallet");
		const seen: unknown[] = [];
		const run = await runMigrationOnTarget(live, {
			listings: [listing],
			cancelListings: async (ctx) => {
				seen.push(ctx);
				return { ok: true, txids: ["c"], errors: [] };
			},
			sweep: async (target) => {
				seen.push(target);
				return null;
			},
		});
		assert.deepEqual(seen, [live.oneSatContext, live]);
		assert.deepEqual(run, { cancelTxids: ["c"], sweep: null });
	});
});

describe("migration screens use the re-rooted wallet", () => {
	const read = (path: string) =>
		readFileSync(join(process.cwd(), path), "utf8");

	it("never sweeps through the provider snapshot after a re-root", () => {
		for (const file of [
			"components/wallet/migration-wizard.tsx",
			"app/(main)/wallet/migrate/page.tsx",
		]) {
			const source = read(file);
			assert.match(source, /runFirstRunMigration\(/, file);
			assert.doesNotMatch(source, /toolbox\.initializeWallet\(/, file);
			assert.doesNotMatch(source, /wallet: toolbox\.wallet/, file);
			assert.doesNotMatch(source, /services: toolbox\.services/, file);
		}
	});
});
