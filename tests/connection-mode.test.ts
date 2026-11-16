import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CONNECTION_OPTION_KEY,
	clearConnection,
	persistBuiltInConnection,
	persistExternalConnection,
	WALLET_CONNECTION_MODE_KEY,
} from "../lib/wallet/connection-mode";
import { EXTERNAL_NETWORK_KEY } from "../lib/wallet-chain";

function deps(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	let refreshes = 0;
	return {
		values,
		get refreshes() {
			return refreshes;
		},
		options: {
			storage: {
				setItem: (key: string, value: string) => void values.set(key, value),
				removeItem: (key: string) => void values.delete(key),
			},
			refresh: () => {
				refreshes += 1;
			},
		},
	};
}

describe("persisted wallet connection", () => {
	it("records an external session with its network and refreshes the chain", () => {
		const env = deps();
		persistExternalConnection("test", "injected", env.options);
		assert.deepEqual(Object.fromEntries(env.values), {
			[WALLET_CONNECTION_MODE_KEY]: "external",
			[CONNECTION_OPTION_KEY]: "injected",
			[EXTERNAL_NETWORK_KEY]: "test",
		});
		assert.equal(env.refreshes, 1);

		persistExternalConnection("main", undefined, env.options);
		assert.equal(env.values.get(EXTERNAL_NETWORK_KEY), "main");
		assert.equal(env.refreshes, 2);
	});

	it("records the built-in wallet and drops the external network", () => {
		const env = deps({
			[WALLET_CONNECTION_MODE_KEY]: "external",
			[CONNECTION_OPTION_KEY]: "desktop",
			[EXTERNAL_NETWORK_KEY]: "test",
		});
		persistBuiltInConnection(env.options);
		assert.deepEqual(Object.fromEntries(env.values), {
			[WALLET_CONNECTION_MODE_KEY]: "built-in",
		});
		assert.equal(env.refreshes, 1);
	});

	it("clears every connection key and refreshes the chain", () => {
		const env = deps({
			[WALLET_CONNECTION_MODE_KEY]: "external",
			[CONNECTION_OPTION_KEY]: "desktop",
			[EXTERNAL_NETWORK_KEY]: "test",
			encryptedBackup: "{}",
		});
		clearConnection(env.options);
		assert.deepEqual(Object.fromEntries(env.values), { encryptedBackup: "{}" });
		assert.equal(env.refreshes, 1);
	});
});
