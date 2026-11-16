import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as walletChain from "../lib/wallet-chain";
import {
	accountNetworkOf,
	createWalletChainStore,
	EXTERNAL_NETWORK_KEY,
	LEGACY_WALLET_CHAIN_KEY,
	migrateLegacyWalletChain,
	parseWalletChain,
	readWalletChain,
	resolveActiveChain,
	syncWalletChainCookie,
	WALLET_CHAIN_COOKIE,
	WALLET_CONNECTION_MODE_KEY,
} from "../lib/wallet-chain";

const MAIN_ENVELOPE = JSON.stringify({
	format: "1sat-web-wallet",
	version: 1,
	cipher: "AES-256-GCM",
	encryptedBackup: "ENC:abc",
	pubKey: "02aa",
});
const TEST_ENVELOPE = JSON.stringify({
	...JSON.parse(MAIN_ENVELOPE),
	network: "test",
});

/** Runs fn with console.error captured, returning what was logged. */
function logged(fn: () => void): unknown[][] {
	const original = console.error;
	const calls: unknown[][] = [];
	console.error = (...args: unknown[]) => void calls.push(args);
	try {
		fn();
	} finally {
		console.error = original;
	}
	return calls;
}

function memoryStorage(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	const writes: string[] = [];
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			writes.push(`set:${key}`);
			values.set(key, value);
		},
		removeItem: (key: string) => {
			writes.push(`remove:${key}`);
			values.delete(key);
		},
		values,
		writes,
	};
}

function storeFor(
	storage: ReturnType<typeof memoryStorage>,
	jar = cookieJar(),
) {
	const events = new EventTarget();
	const store = createWalletChainStore({
		storage: () => storage,
		cookies: () => jar,
		events: () => events,
	});
	return { store, events, jar };
}

describe("active chain", () => {
	it("is mainnet with no wallet, on the server, or with blocked storage", () => {
		assert.equal(resolveActiveChain(memoryStorage()), "main");
		assert.equal(resolveActiveChain(undefined), "main");
		assert.equal(readWalletChain(), "main");
		const errors = logged(() => {
			assert.equal(
				resolveActiveChain({
					getItem: () => {
						throw new Error("blocked");
					},
				}),
				"main",
			);
		});
		// Blocked storage is logged, never swallowed.
		assert.ok(errors.length > 0);
	});

	it("follows the stored account's network", () => {
		assert.equal(
			resolveActiveChain(memoryStorage({ encryptedBackup: MAIN_ENVELOPE })),
			"main",
		);
		assert.equal(
			resolveActiveChain(memoryStorage({ encryptedBackup: TEST_ENVELOPE })),
			"test",
		);
		assert.equal(
			resolveActiveChain(memoryStorage({ encryptedBackup: "{not json" })),
			"main",
		);
		assert.equal(accountNetworkOf(null), null);
		assert.equal(accountNetworkOf("{not json"), null);
		assert.equal(accountNetworkOf("[]"), null);
		assert.equal(accountNetworkOf(MAIN_ENVELOPE), "main");
		assert.equal(accountNetworkOf(TEST_ENVELOPE), "test");
		assert.equal(parseWalletChain("testnet"), "main");
	});

	it("follows a persisted external session over the account", () => {
		const external = (network: string, mode = "external") =>
			memoryStorage({
				encryptedBackup: TEST_ENVELOPE,
				[WALLET_CONNECTION_MODE_KEY]: mode,
				[EXTERNAL_NETWORK_KEY]: network,
			});
		assert.equal(resolveActiveChain(external("main")), "main");
		assert.equal(
			resolveActiveChain(
				memoryStorage({
					encryptedBackup: MAIN_ENVELOPE,
					[WALLET_CONNECTION_MODE_KEY]: "external",
					[EXTERNAL_NETWORK_KEY]: "test",
				}),
			),
			"test",
		);
		// Ignored unless the mode is external, and when invalid.
		assert.equal(resolveActiveChain(external("main", "built-in")), "test");
		assert.equal(resolveActiveChain(external("testnet")), "test");
		assert.equal(resolveActiveChain(external("")), "test");
	});
});

describe("legacy network setting migration", () => {
	it("makes a testnet setting a mainnet account and leaves the envelope as is", () => {
		const storage = memoryStorage({
			encryptedBackup: MAIN_ENVELOPE,
			[LEGACY_WALLET_CHAIN_KEY]: "test",
		});
		const { store } = storeFor(storage);
		assert.equal(store.read(), "main");
		assert.equal(storage.values.has(LEGACY_WALLET_CHAIN_KEY), false);
		assert.equal(storage.values.get("encryptedBackup"), MAIN_ENVELOPE);
		assert.deepEqual(storage.writes, [`remove:${LEGACY_WALLET_CHAIN_KEY}`]);
		assert.equal(store.takeLegacyTestnetNotice(), true);
		assert.equal(store.takeLegacyTestnetNotice(), false);
	});

	it("removes a mainnet setting without a notice", () => {
		const storage = memoryStorage({ [LEGACY_WALLET_CHAIN_KEY]: "main" });
		assert.deepEqual(migrateLegacyWalletChain(storage), { wasTestnet: false });
		assert.equal(storage.values.has(LEGACY_WALLET_CHAIN_KEY), false);
	});

	it("writes nothing without a legacy key, and runs once", () => {
		const storage = memoryStorage({ encryptedBackup: TEST_ENVELOPE });
		const { store } = storeFor(storage);
		assert.equal(store.read(), "test");
		assert.deepEqual(storage.writes, []);
		storage.values.set(LEGACY_WALLET_CHAIN_KEY, "test");
		store.refresh();
		assert.equal(store.read(), "test");
		assert.equal(storage.values.get(LEGACY_WALLET_CHAIN_KEY), "test");
		assert.equal(store.takeLegacyTestnetNotice(), false);
	});

	it("survives storage that refuses the removal", () => {
		const storage = {
			getItem: () => "test",
			removeItem: () => {
				throw new Error("blocked");
			},
		};
		const errors = logged(() => {
			assert.deepEqual(migrateLegacyWalletChain(storage), { wasTestnet: true });
		});
		assert.equal(errors.length, 1);
	});
});

describe("chain store", () => {
	it("notifies only when the active chain changes", () => {
		const storage = memoryStorage({ encryptedBackup: MAIN_ENVELOPE });
		const { store } = storeFor(storage);
		let calls = 0;
		const unsubscribe = store.subscribe(() => {
			calls += 1;
		});
		assert.equal(store.read(), "main");
		store.refresh();
		assert.equal(calls, 0);

		storage.values.set("encryptedBackup", TEST_ENVELOPE);
		store.refresh();
		assert.equal(calls, 1);
		assert.equal(store.read(), "test");
		store.refresh();
		assert.equal(calls, 1);

		unsubscribe();
		storage.values.delete("encryptedBackup");
		store.refresh();
		assert.equal(calls, 1);
		assert.equal(store.read(), "main");
	});

	it("refreshes on a wallet storage event only", () => {
		const storage = memoryStorage({ encryptedBackup: MAIN_ENVELOPE });
		const { store, events } = storeFor(storage);
		let calls = 0;
		store.subscribe(() => {
			calls += 1;
		});
		store.read();

		// A connection change in another tab does not move this tab's chain.
		storage.values.set(WALLET_CONNECTION_MODE_KEY, "external");
		storage.values.set(EXTERNAL_NETWORK_KEY, "test");
		events.dispatchEvent(storageEvent(WALLET_CONNECTION_MODE_KEY));
		assert.equal(store.read(), "main");
		assert.equal(calls, 0);

		storage.values.delete(WALLET_CONNECTION_MODE_KEY);
		storage.values.set("encryptedBackup", TEST_ENVELOPE);
		events.dispatchEvent(storageEvent("encryptedBackup"));
		assert.equal(store.read(), "test");
		assert.equal(calls, 1);
	});

	it("mirrors the chain into a cookie, writing only on a change", () => {
		const storage = memoryStorage({ encryptedBackup: TEST_ENVELOPE });
		const { store, jar } = storeFor(storage);
		assert.equal(store.read(), "test");
		assert.equal(WALLET_CHAIN_COOKIE, "1sat-wallet-chain");
		assert.equal(jar.value, "test");
		assert.match(
			jar.writes.at(-1) ?? "",
			/^1sat-wallet-chain=test; path=\/; SameSite=Lax; max-age=\d{7,}$/,
		);
		store.refresh();
		assert.equal(jar.writes.length, 1);

		storage.values.delete("encryptedBackup");
		store.refresh();
		assert.equal(jar.value, undefined);
		assert.match(
			jar.writes.at(-1) ?? "",
			/^1sat-wallet-chain=; path=\/; SameSite=Lax; max-age=0$/,
		);

		// A stale testnet cookie is deleted on the first read.
		const stale = cookieJar("test");
		assert.equal(storeFor(memoryStorage(), stale).store.read(), "main");
		assert.equal(stale.value, undefined);

		const jarTest = cookieJar("test");
		syncWalletChainCookie("test", jarTest);
		assert.equal(jarTest.writes.length, 0);
		const none = cookieJar();
		syncWalletChainCookie("main", none);
		assert.equal(none.writes.length, 0);
	});

	it("has no manual setter or legacy key export", () => {
		assert.equal("writeWalletChain" in walletChain, false);
		assert.equal("WALLET_CHAIN_KEY" in walletChain, false);
		const source = readFileSync(
			join(process.cwd(), "lib/wallet-chain.ts"),
			"utf8",
		);
		assert.doesNotMatch(source, /setItem\(/);
	});
});

function storageEvent(key: string) {
	const event = new Event("storage") as Event & { key: string };
	Object.defineProperty(event, "key", { value: key });
	return event;
}

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
