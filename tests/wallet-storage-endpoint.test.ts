import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	walletStorageHost,
	walletStorageUrl,
} from "../lib/wallet/storage-endpoint";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("wallet storage endpoint", () => {
	it("uses the hosted storage per chain, with the deploy setting on mainnet only", () => {
		const saved = process.env.NEXT_PUBLIC_WALLET_STORAGE_URL;
		try {
			delete process.env.NEXT_PUBLIC_WALLET_STORAGE_URL;
			assert.equal(walletStorageUrl("main"), "https://wallet.1sat.app");
			assert.equal(walletStorageHost("main"), "wallet.1sat.app");
			assert.equal(walletStorageUrl("test"), "https://testnet.wallet.1sat.app");
			assert.equal(walletStorageHost("test"), "testnet.wallet.1sat.app");
			process.env.NEXT_PUBLIC_WALLET_STORAGE_URL =
				"https://storage.example:8443/wallet";
			assert.equal(
				walletStorageUrl("main"),
				"https://storage.example:8443/wallet",
			);
			assert.equal(walletStorageHost("main"), "storage.example:8443");
			// The override holds a mainnet URL; testnet keys must never use it.
			assert.equal(walletStorageUrl("test"), "https://testnet.wallet.1sat.app");
			assert.equal(walletStorageHost("test"), "testnet.wallet.1sat.app");
		} finally {
			if (saved === undefined)
				delete process.env.NEXT_PUBLIC_WALLET_STORAGE_URL;
			else process.env.NEXT_PUBLIC_WALLET_STORAGE_URL = saved;
		}
	});

	it("never leaves a chain on local-only storage", () => {
		for (const chain of ["main", "test"] as const) {
			assert.match(walletStorageUrl(chain), /^https:\/\//);
		}
	});

	it("is the one config the wallet and Settings both read", () => {
		const provider = read("providers/wallet-toolbox-provider.tsx");
		assert.match(
			provider,
			/const activeRemote = walletStorageUrl\(chain, newIdentityKey\);/,
		);
		assert.doesNotMatch(provider, /https:\/\/wallet\.1sat\.app/);
		const settings = read("components/wallet/wallet-settings-form.tsx");
		assert.match(settings, /<WalletStorageRow \/>/);
		const row = read("components/wallet/wallet-storage-row.tsx");
		assert.match(row, /walletStorageHost\(chain, identityKey/);
		assert.match(row, /Wallet storage/);
	});

	it("uses the provider chosen for an account, and only that account", () => {
		const saved = process.env.NEXT_PUBLIC_WALLET_STORAGE_URL;
		const realWindow = (globalThis as { window?: unknown }).window;
		const items = new Map<string, string>();
		(globalThis as { window?: unknown }).window = {
			localStorage: {
				getItem: (k: string) => items.get(k) ?? null,
				setItem: (k: string, v: string) => items.set(k, v),
				removeItem: (k: string) => items.delete(k),
			},
		};
		try {
			delete process.env.NEXT_PUBLIC_WALLET_STORAGE_URL;
			items.set("1sat.walletStorage.main.02aa", "https://store.example");
			assert.equal(walletStorageUrl("main", "02aa"), "https://store.example");
			assert.equal(walletStorageHost("main", "02aa"), "store.example");
			assert.equal(walletStorageUrl("main", "02bb"), "https://wallet.1sat.app");
			assert.equal(
				walletStorageUrl("test", "02aa"),
				"https://testnet.wallet.1sat.app",
			);
			assert.equal(walletStorageUrl("main"), "https://wallet.1sat.app");
		} finally {
			(globalThis as { window?: unknown }).window = realWindow;
			if (saved === undefined)
				delete process.env.NEXT_PUBLIC_WALLET_STORAGE_URL;
			else process.env.NEXT_PUBLIC_WALLET_STORAGE_URL = saved;
		}
	});
});
