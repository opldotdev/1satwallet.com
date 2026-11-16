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
		assert.match(provider, /const activeRemote = walletStorageUrl\(chain\);/);
		assert.doesNotMatch(provider, /https:\/\/wallet\.1sat\.app/);
		const settings = read("components/wallet/wallet-settings-form.tsx");
		assert.match(settings, /walletStorageHost\(chain\)/);
		assert.match(settings, /Wallet storage/);
	});
});
