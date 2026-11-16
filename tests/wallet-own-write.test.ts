import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PrivateKey } from "@bsv/sdk";
import {
	clearCachedEncryptionKey,
	reencryptWallet,
	saveEncryptedWallet,
	walletChangedElsewhere,
} from "../lib/wallet-storage";

class MemoryStorage {
	values = new Map<string, string>();
	getItem(key: string) {
		return this.values.get(key) ?? null;
	}
	setItem(key: string, value: string) {
		this.values.set(key, value);
	}
	removeItem(key: string) {
		this.values.delete(key);
	}
}

class TestStorageEvent extends Event {
	readonly key: string | null;
	readonly newValue: string | null;
	constructor(
		type: string,
		init: { key?: string | null; newValue?: string | null } = {},
	) {
		super(type);
		this.key = init.key ?? null;
		this.newValue = init.newValue ?? null;
	}
}

const keys = {
	payPk: PrivateKey.fromHex("01".repeat(32)).toWif(),
	ordPk: PrivateKey.fromHex("02".repeat(32)).toWif(),
	identityPk: PrivateKey.fromHex("03".repeat(32)).toWif(),
};
const password = "fixture-password-not-a-secret";

const globals = globalThis as Record<string, unknown>;
const storage = new MemoryStorage();
const events = new EventTarget();
/** How often a WalletProvider-style listener saw a change made elsewhere. */
let locks = 0;

describe("this tab's own wallet writes", () => {
	before(() => {
		// defineProperty, not assignment: another test file may leave these
		// defined as read-only (but configurable) on the shared global.
		for (const [name, value] of [
			["window", Object.assign(events, { localStorage: storage })],
			["StorageEvent", TestStorageEvent],
		] as const) {
			Object.defineProperty(globalThis, name, {
				configurable: true,
				writable: true,
				value,
			});
		}
		// Mirrors WalletProvider: a change made elsewhere locks and drops the
		// key cache; this tab's own save is skipped.
		events.addEventListener("storage", (event) => {
			const exists = walletChangedElsewhere(event as TestStorageEvent, storage);
			if (exists === undefined) return;
			locks += 1;
			clearCachedEncryptionKey();
		});
	});

	after(() => {
		clearCachedEncryptionKey();
		delete globals.window;
		delete globals.StorageEvent;
	});

	it("keeps the key cache after create, so re-encryption works", async () => {
		assert.equal(await saveEncryptedWallet(keys, password, "main"), true);
		assert.equal(locks, 0);
		assert.equal(
			await reencryptWallet({ ...keys, ordAddressPath: "m/0/1" }),
			true,
		);
		// Re-encryption's own notification is skipped too.
		assert.equal(locks, 0);
		assert.equal(await reencryptWallet(keys), true);
	});

	it("still locks on another tab's write and on clear()", async () => {
		events.dispatchEvent(
			new TestStorageEvent("storage", {
				key: "encryptedBackup",
				newValue: storage.getItem("encryptedBackup"),
			}),
		);
		assert.equal(locks, 1);
		assert.equal(await reencryptWallet(keys), false);

		assert.equal(await saveEncryptedWallet(keys, password, "main"), true);
		assert.equal(await reencryptWallet(keys), true);
		storage.values.clear();
		events.dispatchEvent(new TestStorageEvent("storage", { key: null }));
		assert.equal(locks, 2);
		assert.equal(await reencryptWallet(keys), false);

		// Unrelated keys are ignored.
		events.dispatchEvent(
			new TestStorageEvent("storage", { key: "other", newValue: "x" }),
		);
		assert.equal(locks, 2);
	});
});
