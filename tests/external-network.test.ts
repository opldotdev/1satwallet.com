import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { externalNetworkMismatch } from "../lib/wallet/external-network";

const on = (network: string) => ({
	getNetwork: async () => ({ network }) as { network: "mainnet" | "testnet" },
});

describe("external wallet network check", () => {
	it("accepts a wallet on the selected chain", async () => {
		assert.equal(await externalNetworkMismatch(on("mainnet"), "main"), null);
		assert.equal(await externalNetworkMismatch(on("testnet"), "test"), null);
	});

	it("rejects a wallet on the other chain with a plain message", async () => {
		assert.equal(
			await externalNetworkMismatch(on("mainnet"), "test"),
			"This wallet is on mainnet. Switch the network in Wallet settings or use another wallet.",
		);
		assert.equal(
			await externalNetworkMismatch(on("testnet"), "main"),
			"This wallet is on testnet. Switch the network in Wallet settings or use another wallet.",
		);
	});

	it("treats a wallet that cannot report its network as mainnet", async () => {
		const throws = {
			getNetwork: async () => {
				throw new Error("unsupported");
			},
		};
		assert.equal(await externalNetworkMismatch(throws, "main"), null);
		assert.equal(await externalNetworkMismatch({}, "main"), null);
		const mainnetMessage =
			"This wallet is on mainnet. Switch the network in Wallet settings or use another wallet.";
		assert.equal(await externalNetworkMismatch(throws, "test"), mainnetMessage);
		assert.equal(await externalNetworkMismatch({}, "test"), mainnetMessage);
	});

	it("rejects an explicitly unknown network", async () => {
		assert.notEqual(await externalNetworkMismatch(on("regtest"), "main"), null);
	});

	it("checks and disconnects in both connect paths", () => {
		const provider = readFileSync(
			join(process.cwd(), "providers/wallet-toolbox-provider.tsx"),
			"utf8",
		);
		const checks = [
			...provider.matchAll(
				/const networkError = await externalNetworkMismatch\(\s*result\.wallet,\s*chain,\s*\);\s*if \(networkError\) \{[^}]*?result\.disconnect\(\);[^}]*?setInitError\(/g,
			),
		];
		assert.equal(checks.length, 2);
		const connect = provider.slice(
			provider.indexOf("const connectExternalWallet"),
			provider.indexOf("const switchWallet"),
		);
		assert.ok(
			connect.indexOf("externalNetworkMismatch") <
				connect.indexOf("deriveExternalAddresses(\n"),
		);
	});
});
