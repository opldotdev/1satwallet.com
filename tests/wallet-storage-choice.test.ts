import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	loadStorageChoice,
	normalizeStorageUrl,
	type StorageChoiceStore,
	saveStorageChoice,
} from "@/lib/wallet/storage-choice";

function memoryStore(): StorageChoiceStore & { data: Map<string, string> } {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (k) => data.get(k) ?? null,
		setItem: (k, v) => void data.set(k, v),
		removeItem: (k) => void data.delete(k),
	};
}

const DEFAULT = "https://wallet.1sat.app";

describe("normalizeStorageUrl", () => {
	it("keeps https addresses and drops a trailing slash", () => {
		assert.equal(
			normalizeStorageUrl(" https://store.example/ "),
			"https://store.example",
		);
		assert.equal(
			normalizeStorageUrl("https://store.example/v1/"),
			"https://store.example/v1",
		);
	});

	it("allows http only for localhost", () => {
		assert.equal(
			normalizeStorageUrl("http://localhost:8110"),
			"http://localhost:8110",
		);
		assert.throws(() => normalizeStorageUrl("http://store.example"));
	});

	it("refuses non-URLs, logins and queries", () => {
		assert.throws(() => normalizeStorageUrl("store.example"));
		assert.throws(() => normalizeStorageUrl("https://u:p@store.example"));
		assert.throws(() => normalizeStorageUrl("https://store.example/?token=1"));
	});
});

describe("storage choice", () => {
	it("is saved per chain and identity key", () => {
		const store = memoryStore();
		saveStorageChoice("main", "02aa", "https://store.example/", DEFAULT, store);
		assert.equal(
			loadStorageChoice("main", "02aa", store),
			"https://store.example",
		);
		assert.equal(loadStorageChoice("test", "02aa", store), null);
		assert.equal(loadStorageChoice("main", "02bb", store), null);
	});

	it("saving the hosted default clears the entry", () => {
		const store = memoryStore();
		saveStorageChoice("main", "02aa", "https://store.example", DEFAULT, store);
		saveStorageChoice("main", "02aa", `${DEFAULT}/`, DEFAULT, store);
		assert.equal(store.data.size, 0);
		saveStorageChoice("main", "02aa", "https://store.example", DEFAULT, store);
		saveStorageChoice("main", "02aa", null, DEFAULT, store);
		assert.equal(store.data.size, 0);
	});

	it("ignores a saved value that is no longer a valid address", () => {
		const store = memoryStore();
		store.setItem("1sat.walletStorage.main.02aa", "http://store.example");
		assert.equal(loadStorageChoice("main", "02aa", store), null);
	});
});
