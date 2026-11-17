import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { OneSatContext } from "@1sat/actions";
import type { OneSatServices } from "@1sat/client";
import { wifToHex } from "@1sat/utils";
import { PrivateKey, type WalletInterface } from "@bsv/sdk";
import { emptySweepResult } from "@/lib/sweep-migration";
import {
	ListingCancelError,
	type MigrationTarget,
	partialRunResult,
	requireMigrationTarget,
	runFirstRunMigration,
	runMigrationOnTarget,
} from "@/lib/wallet/first-run-migration";
import type { ListedAsset } from "@/lib/wallet/migration-listings";
import { PayKeyTransferIncompleteError } from "@/lib/wallet/pay-key-transfer";

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
	const transferredFrom: OneSatContext[] = [];
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
		transferPayKeyWallet: async (ctx: OneSatContext, wif: string) => {
			log.push("transfer");
			transferredFrom.push(ctx);
			assert.equal(wif, identityWif);
			return { address: "identity-deposit", txids: ["move-1"] };
		},
		sweep: async (target: MigrationTarget) => {
			log.push("sweep");
			swept.push(target);
			return emptySweepResult({ bsvTxids: ["bsv-1"] });
		},
	};
	return { deps, legacy, log, swept, cancelledOn, transferredFrom };
}

describe("first-run migration re-root", () => {
	// The failure paths log in full; keep test output (and Next's patched
	// console in a full run) out of it.
	const originalError = console.error;
	beforeEach(() => {
		console.error = () => undefined;
	});
	afterEach(() => {
		console.error = originalError;
	});

	it("sweeps into the wallet initializeWallet returned, never the destroyed one", async () => {
		const fresh = fakeTarget(identityKey, "identity wallet");
		let rootSeen = "";
		const { deps, legacy, log, swept, cancelledOn, transferredFrom } = harness(
			async (hex) => {
				rootSeen = hex;
				return fresh;
			},
		);

		const run = await runFirstRunMigration(deps);

		assert.equal(rootSeen, wifToHex(identityWif));
		assert.deepEqual(log, [
			"cancel",
			"transfer",
			"persist",
			"destroy",
			"init",
			"sweep",
		]);
		// The wallet's own listings belong to the running wallet: cancelled
		// there, before anything is changed, then everything it holds moves.
		assert.equal(cancelledOn[0], legacy.oneSatContext);
		assert.equal(transferredFrom[0], legacy.oneSatContext);
		assert.deepEqual(run.transferTxids, ["move-1"]);
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
			assert.match(error.message, /Listing x: declined/);
			return true;
		});
		assert.deepEqual(log, []);
	});

	it("names each failed cancel and returns the cancels that went through", async () => {
		const { deps, log } = harness(async () =>
			fakeTarget(identityKey, "identity wallet"),
		);
		const partial = {
			...deps,
			listings: [listing, { ...listing, outpoint: `${"bb".repeat(32)}.0` }],
			cancelListings: async () => ({
				ok: false,
				txids: ["cancel-ok"],
				errors: [`Listing ${"bb".repeat(32)}.0: declined`],
			}),
		};
		await assert.rejects(runFirstRunMigration(partial), (error: unknown) => {
			assert.ok(error instanceof ListingCancelError);
			assert.match(error.message, /1 of 2 not cancelled/);
			assert.match(error.message, /bbbb.*: declined/);
			assert.match(error.message, /Cancelled 1: cancel-ok/);
			assert.deepEqual(error.cancelTxids, ["cancel-ok"]);
			assert.deepEqual(partialRunResult(error)?.cancelTxids, ["cancel-ok"]);
			return true;
		});
		assert.deepEqual(log, []);
	});

	it("does not re-root while the pay-key wallet still holds anything", async () => {
		const { deps, log } = harness(async () =>
			fakeTarget(identityKey, "identity wallet"),
		);
		const stuck = new PayKeyTransferIncompleteError(
			[
				{
					basket: "lock",
					outpoint: `${"cc".repeat(32)}.0`,
					reason: "time-locked BSV; unlock it once the lock ends, then migrate",
				},
			],
			["move-1"],
			[],
		);
		const blocked = {
			...deps,
			transferPayKeyWallet: async () => {
				log.push("transfer");
				throw stuck;
			},
		};
		await assert.rejects(runFirstRunMigration(blocked), (error: unknown) => {
			assert.equal(error, stuck);
			assert.match(stuck.message, /not switched to the identity key/);
			assert.match(stuck.message, /1 in "lock"/);
			assert.match(stuck.message, /time-locked/);
			assert.match(stuck.message, /move-1/);
			assert.deepEqual(partialRunResult(error), {
				cancelTxids: ["cancel-1"],
				transferTxids: ["move-1"],
				errors: [],
			});
			return true;
		});
		// Nothing after the transfer ran: keys unchanged, wallet not destroyed.
		assert.deepEqual(log, ["cancel", "transfer"]);
	});

	it("skips the transfer for a wallet already rooted at the identity key", async () => {
		const { deps, log } = harness(async () =>
			fakeTarget(identityKey, "identity wallet"),
		);
		const run = await runFirstRunMigration({
			...deps,
			current: fakeTarget(identityKey, "already identity-rooted"),
		});
		assert.deepEqual(log, ["cancel", "persist", "destroy", "init", "sweep"]);
		assert.deepEqual(run.transferTxids, []);
	});

	it("says where the assets went when saving the keys fails after the move", async () => {
		const { deps, log } = harness(async () =>
			fakeTarget(identityKey, "identity wallet"),
		);
		await assert.rejects(
			runFirstRunMigration({
				...deps,
				persistIdentity: async () => {
					log.push("persist");
					throw new Error("Failed to re-encrypt wallet.");
				},
			}),
			/Failed to re-encrypt wallet\. .*identity key's deposit address \(move-1\).*run it again/,
		);
		assert.deepEqual(log, ["cancel", "transfer", "persist"]);
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
		assert.deepEqual(run, {
			cancelTxids: ["c"],
			transferTxids: [],
			sweep: null,
		});
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
