import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PrivateKey } from "@bsv/sdk";
import { MAINNET_ONLY_HOSTS, TESTNET_FAUCET_URL } from "../e2e/support/env";
import {
	createTestnetBackup,
	openTestnetBackup,
} from "../e2e/support/test-network";
import { endpointsOf } from "../lib/chain-endpoints";
import { createEncryptedWalletBackup } from "../lib/wallet-storage";

const keys = {
	payPk: PrivateKey.fromHex("01".repeat(32)).toWif(),
	ordPk: PrivateKey.fromHex("02".repeat(32)).toWif(),
	identityPk: PrivateKey.fromHex("03".repeat(32)).toWif(),
};
const passphrase = "fixture-password-not-a-secret";

describe("e2e test wallet guard", () => {
	test("accepts a testnet envelope and returns the public identity key", async () => {
		const backup = await createTestnetBackup(keys, passphrase);
		assert.equal(backup.includes("\n"), false);
		assert.equal(JSON.parse(backup).network, "test");
		const opened = await openTestnetBackup(backup, passphrase, "backup");
		assert.equal(
			opened.identityKey,
			PrivateKey.fromHex("03".repeat(32)).toPublicKey().toString(),
		);
	});

	test("refuses a mainnet envelope", async () => {
		const backup = JSON.stringify(
			await createEncryptedWalletBackup(keys, passphrase, "main"),
		);
		await assert.rejects(
			openTestnetBackup(backup, passphrase, "backup"),
			/does not say network "test"/,
		);
	});

	test("refuses a mainnet payload whose envelope was edited to say testnet", async () => {
		const mainnet = await createEncryptedWalletBackup(keys, passphrase, "main");
		const edited = JSON.stringify({ ...mainnet, network: "test" });
		await assert.rejects(
			openTestnetBackup(edited, passphrase, "backup"),
			/encrypted payload of backup does not say network "test"/,
		);
	});

	test("names the setting when the passphrase is wrong", async () => {
		const backup = await createTestnetBackup(keys, passphrase);
		await assert.rejects(
			openTestnetBackup(backup, "wrong-passphrase", "E2E_WALLET_A_BACKUP"),
			/E2E_WALLET_A_BACKUP could not be decrypted/,
		);
	});
});

test("e2e copies of the chain endpoints match lib/chain-endpoints", () => {
	assert.equal(TESTNET_FAUCET_URL, endpointsOf("test").faucet);
	assert.deepEqual(MAINNET_ONLY_HOSTS, [
		new URL(endpointsOf("main").storage).host,
		new URL(endpointsOf("main").messagebox).host,
	]);
});
