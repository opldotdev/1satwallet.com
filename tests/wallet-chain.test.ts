import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	parseWalletChain,
	readWalletChain,
	syncWalletChainCookie,
	WALLET_CHAIN_COOKIE,
	WALLET_CHAIN_KEY,
	writeWalletChain,
} from "../lib/wallet-chain";

function memoryStorage(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, value),
		values,
	};
}

describe("wallet chain setting", () => {
	it("defaults to mainnet", () => {
		assert.equal(readWalletChain(memoryStorage()), "main");
		assert.equal(readWalletChain(undefined), "main");
	});

	it("round-trips both chains under one key", () => {
		const storage = memoryStorage();
		writeWalletChain("test", storage);
		assert.equal(storage.values.get(WALLET_CHAIN_KEY), "test");
		assert.equal(readWalletChain(storage), "test");
		writeWalletChain("main", storage);
		assert.equal(readWalletChain(storage), "main");
		assert.equal(WALLET_CHAIN_KEY, "1sat-wallet-chain");
	});

	it("falls back to mainnet on a bad or unreadable value", () => {
		for (const value of ["testnet", "TEST", "", "mainnet", "{}"]) {
			assert.equal(
				readWalletChain(memoryStorage({ [WALLET_CHAIN_KEY]: value })),
				"main",
			);
		}
		assert.equal(parseWalletChain(undefined), "main");
		assert.equal(
			readWalletChain({
				getItem: () => {
					throw new Error("blocked");
				},
				setItem: () => {},
			}),
			"main",
		);
	});

	it("mirrors the chain into a cookie on set and on read", () => {
		const jar = cookieJar();
		writeWalletChain("test", memoryStorage(), jar);
		assert.equal(WALLET_CHAIN_COOKIE, "1sat-wallet-chain");
		assert.equal(jar.value, "test");
		assert.match(
			jar.writes.at(-1) ?? "",
			/^1sat-wallet-chain=test; path=\/; SameSite=Lax; max-age=\d{7,}$/,
		);

		writeWalletChain("main", memoryStorage(), jar);
		assert.equal(jar.value, undefined);
		assert.match(
			jar.writes.at(-1) ?? "",
			/^1sat-wallet-chain=; path=\/; SameSite=Lax; max-age=0$/,
		);

		// A setting saved before the cookie existed gets it on the first read.
		const fresh = cookieJar();
		assert.equal(
			readWalletChain(memoryStorage({ [WALLET_CHAIN_KEY]: "test" }), fresh),
			"test",
		);
		assert.equal(fresh.value, "test");
		const stale = cookieJar("test");
		assert.equal(readWalletChain(memoryStorage(), stale), "main");
		assert.equal(stale.value, undefined);
	});

	it("writes the cookie only when it changes", () => {
		const jar = cookieJar("test");
		syncWalletChainCookie("test", jar);
		assert.equal(jar.writes.length, 0);
		const none = cookieJar();
		syncWalletChainCookie("main", none);
		assert.equal(none.writes.length, 0);
	});
});

function cookieJar(initial?: string) {
	const jar = {
		value: initial as string | undefined,
		writes: [] as string[],
		get cookie() {
			return jar.value === undefined
				? "other=1"
				: `other=1; ${WALLET_CHAIN_COOKIE}=${jar.value}`;
		},
		set cookie(entry: string) {
			jar.writes.push(entry);
			const [pair] = entry.split(";");
			const value = pair.slice(pair.indexOf("=") + 1);
			jar.value = /max-age=0(;|$)/.test(entry) ? undefined : value;
		},
	};
	return jar;
}
