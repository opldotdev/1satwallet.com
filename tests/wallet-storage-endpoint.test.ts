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
	it("uses the deploy setting, else wallet.1sat.app on mainnet and local on testnet", () => {
		const saved = process.env.NEXT_PUBLIC_WALLET_STORAGE_URL;
		try {
			delete process.env.NEXT_PUBLIC_WALLET_STORAGE_URL;
			assert.equal(walletStorageUrl("main"), "https://wallet.1sat.app");
			assert.equal(walletStorageHost("main"), "wallet.1sat.app");
			assert.equal(walletStorageUrl("test"), undefined);
			assert.equal(walletStorageHost("test"), undefined);
			process.env.NEXT_PUBLIC_WALLET_STORAGE_URL =
				"https://storage.example:8443/wallet";
			assert.equal(walletStorageHost("main"), "storage.example:8443");
		} finally {
			if (saved === undefined)
				delete process.env.NEXT_PUBLIC_WALLET_STORAGE_URL;
			else process.env.NEXT_PUBLIC_WALLET_STORAGE_URL = saved;
		}
	});

	it("is the one config the wallet and Settings both read", () => {
		const provider = read("providers/wallet-toolbox-provider.tsx");
		assert.match(provider, /const activeRemote = walletStorageUrl\(chain\);/);
		assert.doesNotMatch(provider, /https:\/\/wallet\.1sat\.app/);
		const settings = read("components/wallet/wallet-settings-form.tsx");
		assert.match(settings, /walletStorageHost\(chain\)/);
		assert.match(settings, /Wallet Storage/);
	});
});
