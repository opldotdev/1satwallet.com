import assert from "node:assert/strict";
import { it } from "node:test";
import type { WalletClient } from "@bsv/sdk";
import {
	connectSelectedWallet,
	isConnectionAvailable,
	prepareWalletSwitch,
	WalletSwitchError,
} from "@/lib/wallet/connection-options";

it("discovers availability without requesting authentication or identity", async () => {
	const calls: string[] = [];
	const client = {
		getVersion: async () => {
			calls.push("version");
			return { version: "1" };
		},
		waitForAuthentication: async () => {
			throw new Error("unexpected authentication");
		},
		getPublicKey: async () => {
			throw new Error("unexpected identity");
		},
	} as unknown as WalletClient;
	assert.equal(await isConnectionAvailable("injected", () => client), true);
	assert.deepEqual(calls, ["version"]);
});
it("reports unavailable wallets and bounds unresponsive discovery", async () => {
	assert.equal(
		await isConnectionAvailable("desktop", () => {
			throw new Error("unavailable");
		}),
		false,
	);
	const client = {
		getVersion: () => new Promise(() => {}),
	} as unknown as WalletClient;
	assert.equal(await isConnectionAvailable("desktop", () => client), false);
});
it("authenticates the selected wallet before requesting its identity", async () => {
	const calls: string[] = [];
	const client = {
		connectToSubstrate: async () => {
			calls.push("connect");
		},
		waitForAuthentication: async () => {
			calls.push("authenticate");
		},
		getPublicKey: async (args: unknown) => {
			assert.deepEqual(args, { identityKey: true });
			calls.push("identity");
			return { publicKey: "identity" };
		},
	} as unknown as WalletClient;
	const result = await connectSelectedWallet("desktop", (option) => {
		assert.equal(option, "desktop");
		return client;
	});
	assert.equal(result.wallet, client);
	assert.equal(result.provider, "desktop");
	assert.deepEqual(calls, ["connect", "authenticate", "identity"]);
});
it("does not fall back to another wallet after denied authentication", async () => {
	let clients = 0;
	const client = {
		connectToSubstrate: async () => {},
		waitForAuthentication: async () => {
			throw new Error("denied");
		},
		getPublicKey: async () => {
			throw new Error("identity must not be requested");
		},
	} as unknown as WalletClient;
	await assert.rejects(
		connectSelectedWallet("injected", () => {
			clients++;
			return client;
		}),
		/denied/,
	);
	assert.equal(clients, 1);
});
it("refuses an unavailable switch target before connecting", async () => {
	let connected = 0;
	await assert.rejects(
		() =>
			prepareWalletSwitch("desktop", {
				probe: async () => false,
				connect: async () => {
					connected++;
					throw new Error("must not connect");
				},
			}),
		(error: unknown) =>
			error instanceof WalletSwitchError && error.reason === "unavailable",
	);
	assert.equal(connected, 0);
});
it("keeps identity derivation failures distinct from a missing wallet", async () => {
	await assert.rejects(
		() =>
			prepareWalletSwitch("injected", {
				probe: async () => true,
				connect: async () => {
					throw new Error("identity key missing");
				},
			}),
		(error: unknown) =>
			error instanceof WalletSwitchError && error.reason === "identity-failed",
	);
});
