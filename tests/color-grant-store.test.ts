// The 1Color basket grant stores on an in-memory IndexedDB: one per wallet and
// chain, deleted with the wallet, and able to recover from a failed open.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { PromptRequest } from "@1sat/permission-module";
import {
	colorPermissionStore,
	createColorTokenAccessHandler,
	deleteColorPermissionStores,
	RecoveringPermissionStore,
} from "@/lib/cwi/color-consent";
import {
	clearDiagnostics,
	getDiagnosticEvents,
} from "@/lib/runtime-diagnostics";

const ADMIN = "1satwallet.com";
const APP = "swap.example.com";
const WALLET_A = `02${"aa".repeat(32)}`;
const WALLET_B = `03${"bb".repeat(32)}`;
const BASKET = "p color assets";
const grantKey = { type: "basket", originator: APP, basket: BASKET } as const;
const grant = { key: grantKey, expiry: 0, grantedAt: 1 };

const originalError = console.error;
let logged: unknown[][] = [];
beforeEach(() => {
	logged = [];
	console.error = (...args: unknown[]) => {
		logged.push(args);
	};
});
afterEach(async () => {
	console.error = originalError;
	clearDiagnostics();
	await deleteColorPermissionStores(null);
});

/** The color grant databases; other tests' databases share this IndexedDB. */
const databaseNames = async () =>
	(await indexedDB.databases())
		.map((database) => database.name ?? "")
		.filter((name) =>
			name.startsWith("1sat-wallet-permissions:1satwallet-color-"),
		)
		.sort();

const read = JSON.stringify({
	type: "color_access",
	basket: BASKET,
	seekPermission: true,
});

const handlerFor = (identityKey: string) => {
	const prompts: PromptRequest[] = [];
	const handler = createColorTokenAccessHandler({
		promptHandler: async (request) => {
			prompts.push(request);
			return true;
		},
		permissionStore: colorPermissionStore("test", identityKey),
		adminOriginator: ADMIN,
	});
	return { handler, prompts };
};

describe("color grant stores", () => {
	it("keep one store per wallet and chain", async () => {
		assert.equal(
			colorPermissionStore("test", WALLET_A),
			colorPermissionStore("test", WALLET_A),
		);
		assert.notEqual(
			colorPermissionStore("test", WALLET_A),
			colorPermissionStore("test", WALLET_B),
		);
		assert.notEqual(
			colorPermissionStore("test", WALLET_A),
			colorPermissionStore("main", WALLET_A),
		);
		await colorPermissionStore("test", WALLET_A).putGrant(grant);
		assert.deepEqual(await databaseNames(), [
			`1sat-wallet-permissions:1satwallet-color-test-${WALLET_A}`,
		]);
	});

	it("never answer one wallet's read with another wallet's grant", async () => {
		const a = handlerFor(WALLET_A);
		assert.equal(await a.handler(APP, read), true);
		assert.equal(await a.handler(APP, read), true);
		assert.equal(a.prompts.length, 1);
		const b = handlerFor(WALLET_B);
		assert.equal(await b.handler(APP, read), true);
		assert.equal(b.prompts.length, 1);
		assert.ok(await colorPermissionStore("test", WALLET_A).findGrant(grantKey));
	});

	it("are deleted with the wallet, its own and any other left behind", async () => {
		const other = indexedDB.open("another-database", 1);
		await new Promise((resolve) => {
			other.onsuccess = resolve;
		});
		other.result.close();
		await colorPermissionStore("test", WALLET_A).putGrant(grant);
		await colorPermissionStore("test", WALLET_B).putGrant(grant);
		await deleteColorPermissionStores({ chain: "test", identityKey: WALLET_A });
		assert.deepEqual(await databaseNames(), []);
		// Nothing but color grant stores is touched.
		assert.ok(
			(await indexedDB.databases()).some(
				(database) => database.name === "another-database",
			),
		);
		// A store asked for again starts empty.
		assert.equal(
			await colorPermissionStore("test", WALLET_A).findGrant(grantKey),
			null,
		);
	});

	it("delete the removed wallet's store where the browser lists no databases", async () => {
		await colorPermissionStore("test", WALLET_A).putGrant(grant);
		await colorPermissionStore("test", WALLET_B).putGrant(grant);
		const databases = indexedDB.databases;
		Object.defineProperty(indexedDB, "databases", {
			configurable: true,
			value: undefined,
		});
		try {
			await deleteColorPermissionStores({
				chain: "test",
				identityKey: WALLET_A,
			});
		} finally {
			Object.defineProperty(indexedDB, "databases", {
				configurable: true,
				value: databases,
			});
		}
		assert.deepEqual(await databaseNames(), [
			`1sat-wallet-permissions:1satwallet-color-test-${WALLET_B}`,
		]);
	});
});

describe("RecoveringPermissionStore", () => {
	it("opens again after a failed open, and logs the failure", async () => {
		const store = new RecoveringPermissionStore(
			`1satwallet-color-test-${WALLET_A}`,
		);
		const open = indexedDB.open;
		let failures = 1;
		indexedDB.open = ((name: string, version?: number) => {
			if (failures-- <= 0) return open.call(indexedDB, name, version);
			const request = {} as IDBOpenDBRequest;
			queueMicrotask(() => {
				Object.defineProperty(request, "error", {
					value: new DOMException("blocked", "UnknownError"),
				});
				request.onerror?.(new Event("error"));
			});
			return request;
		}) as typeof indexedDB.open;
		try {
			await assert.rejects(store.findGrant(grantKey), /blocked/);
			await store.putGrant(grant);
			assert.deepEqual(await store.findGrant(grantKey), grant);
		} finally {
			indexedDB.open = open;
			await store.close();
		}
		assert.ok(
			getDiagnosticEvents().some(
				(event) => event.operation === "wallet.color-consent.store.findGrant",
			),
		);
		assert.deepEqual(
			logged
				.filter((args) => args[0] !== "[diagnostic]")
				.map((args) => args[0]),
			["[wallet] 1Color grant store: findGrant failed"],
		);
	});
});
