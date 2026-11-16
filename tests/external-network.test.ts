import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	EXTERNAL_NETWORK_CHANGED,
	externalWalletChain,
	UNKNOWN_EXTERNAL_NETWORK,
} from "../lib/wallet/external-network";

async function logged(
	method: "error" | "warn",
	fn: () => Promise<void>,
): Promise<unknown[][]> {
	const original = console[method];
	const calls: unknown[][] = [];
	console[method] = (...args: unknown[]) => void calls.push(args);
	try {
		await fn();
	} finally {
		console[method] = original;
	}
	return calls;
}

const on = (network: string) => ({
	getNetwork: async () => ({ network }) as { network: "mainnet" | "testnet" },
});

describe("external wallet network", () => {
	it("maps the reported network to the active chain", async () => {
		assert.deepEqual(await externalWalletChain(on("mainnet")), {
			chain: "main",
		});
		assert.deepEqual(await externalWalletChain(on("testnet")), {
			chain: "test",
		});
	});

	it("treats a wallet that cannot report its network as mainnet", async () => {
		const throws = {
			getNetwork: async () => {
				throw new Error("unsupported");
			},
		};
		const warnings = await logged("warn", async () => {
			assert.deepEqual(await externalWalletChain(throws), { chain: "main" });
		});
		assert.equal(warnings.length, 1);
		assert.deepEqual(await externalWalletChain({}), { chain: "main" });
		assert.deepEqual(await externalWalletChain(on("")), { chain: "main" });
	});

	it("rejects an explicitly unknown network", async () => {
		const errors = await logged("error", async () => {
			assert.deepEqual(await externalWalletChain(on("regtest")), {
				error: "This wallet reported an unknown network. Use another wallet.",
			});
		});
		assert.equal(errors.length, 1);
		assert.equal(
			EXTERNAL_NETWORK_CHANGED,
			"This wallet changed network while connecting. Try again.",
		);
		assert.equal(
			UNKNOWN_EXTERNAL_NETWORK,
			"This wallet reported an unknown network. Use another wallet.",
		);
	});

	it("follows the wallet's network in both connect paths", () => {
		const provider = readFileSync(
			join(process.cwd(), "providers/wallet-toolbox-provider.tsx"),
			"utf8",
		);
		assert.doesNotMatch(provider, /externalNetworkMismatch/);
		assert.doesNotMatch(provider, /Switch the network/);
		const connect = provider.slice(
			provider.indexOf("const connectExternal = useCallback"),
			provider.indexOf("const connectExternalWallet = useCallback"),
		);
		const switcher = provider.slice(
			provider.indexOf("const switchWallet"),
			provider.indexOf("// Unmount"),
		);
		for (const path of [connect, switcher]) {
			assert.match(path, /await externalWalletChain\(result\.wallet\)/);
			assert.match(
				path,
				/persistExternalConnection\(reported\.chain, option\)/,
			);
			assert.match(path, /persistExternalConnection\(chain, option\)/);
			assert.ok(
				path.indexOf("externalWalletChain") <
					path.indexOf("deriveExternalAddresses("),
			);
		}
		// One hop at most: the reconnect after a hop fails instead of moving again.
		assert.match(connect, /!hasExternalHop\(\)/);
		assert.match(connect, /EXTERNAL_NETWORK_CHANGED/);
		// A remount on another chain keeps the session that decides the chain.
		assert.match(
			provider,
			/teardownWallet\("disconnected", \{ keepConnection: true \}\)/,
		);
		assert.doesNotMatch(
			provider,
			/localStorage\.(setItem|removeItem)\(\s*(WALLET_CONNECTION_MODE_KEY|CONNECTION_OPTION_KEY)/,
		);
	});
});
