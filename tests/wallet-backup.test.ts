import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { PrivateKey, Utils } from "@bsv/sdk";
import { encryptBackup } from "bitcoin-backup";
import {
	decryptWalletBackup,
	detectWalletBackup,
	wifNetwork,
} from "../lib/wallet-backup";
import { migrationDeferredKey } from "../lib/wallet-migration";
import {
	commitWalletBackup,
	createEncryptedWalletBackup,
	decryptEncryptedWalletBackup,
	loadEncryptedWallet,
	parseEncryptedBackupJson,
	reencryptWallet,
} from "../lib/wallet-storage";

class MemoryStorage {
	value: string | null;
	failVerification = false;

	constructor(value: string | null = null) {
		this.value = value;
	}

	getItem() {
		return this.value;
	}

	setItem(_key: string, value: string) {
		this.value = this.failVerification ? `${value}-corrupt` : value;
		this.failVerification = false;
	}

	removeItem() {
		this.value = null;
	}
}

const keys = {
	payPk: PrivateKey.fromHex("01".repeat(32)).toWif(),
	ordPk: PrivateKey.fromHex("02".repeat(32)).toWif(),
	identityPk: PrivateKey.fromHex("03".repeat(32)).toWif(),
	mnemonic:
		"abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
};

async function fixture(name: string) {
	const encoded = await readFile(
		new URL(`./fixtures/${name}.zip.b64`, import.meta.url),
		"utf8",
	);
	return Uint8Array.from(Buffer.from(encoded.trim(), "base64"));
}

describe("wallet backup and restore", () => {
	test("creates, backs up, removes, and restores without exposing plaintext", async () => {
		const password = "fixture-password-not-a-secret";
		const encrypted = await createEncryptedWalletBackup(keys, password);
		const serialized = JSON.stringify(encrypted);
		assert.equal(serialized.includes(keys.payPk), false);
		assert.equal(serialized.includes(keys.mnemonic), false);

		const storage = new MemoryStorage();
		commitWalletBackup(storage, serialized);
		const downloaded = storage.value;
		storage.removeItem();
		assert.equal(storage.value, null);

		const detected = detectWalletBackup(
			new TextEncoder().encode(downloaded ?? ""),
			"wallet.json",
		);
		const { keys: restored, network } = await decryptWalletBackup(
			detected,
			password,
		);
		// A file without a network field may predate it: the person chooses.
		assert.equal(network, null);
		commitWalletBackup(storage, downloaded ?? "");
		assert.equal(restored.payPk, keys.payPk);
		assert.equal(restored.ordPk, keys.ordPk);
		assert.equal(restored.identityPk, keys.identityPk);
		assert.equal(restored.mnemonic, keys.mnemonic);
		assert.equal(storage.value, downloaded);
	});

	test("wrong passwords and failed writes preserve the original wallet", async () => {
		const original = "original-wallet";
		const storage = new MemoryStorage(original);
		storage.failVerification = true;
		assert.throws(() => commitWalletBackup(storage, "replacement"));
		assert.equal(storage.value, original);

		const encrypted = await createEncryptedWalletBackup(
			keys,
			"correct-password",
		);
		const detected = detectWalletBackup(
			new TextEncoder().encode(JSON.stringify(encrypted)),
			"wallet.json",
		);
		await assert.rejects(decryptWalletBackup(detected, "wrong-password"));
		assert.equal(storage.value, original);
	});

	test("reads independently generated current and 2024 Yours fixtures", async () => {
		const current = detectWalletBackup(await fixture("yours-v6"), "yours.zip");
		assert.equal(current.kind, "yours-keys");
		assert.equal(current.version, 6);
		assert.equal(current.archiveVersion, 0);
		assert.equal(current.requiresPassword, true);
		assert.equal(current.network, "main");
		const { keys: currentKeys, network } = await decryptWalletBackup(
			current,
			"fixture-password-not-a-secret",
		);
		assert.equal(network, "main");
		assert.equal(currentKeys.mnemonic?.split(" ").length, 12);
		await assert.rejects(decryptWalletBackup(current, "wrong-password"));

		const legacy = detectWalletBackup(await fixture("yours-v1"), "yours.zip");
		assert.equal(legacy.kind, "yours-keys");
		assert.equal(legacy.version, 1);
		assert.equal(legacy.archiveVersion, 0);
		assert.equal(legacy.requiresPassword, false);
		assert.ok((await decryptWalletBackup(legacy, "")).keys.identityPk);
	});

	test("reads the current bitcoin-backup 1Sat envelope", async () => {
		const encrypted = await encryptBackup(keys, "portable-password");
		const detected = detectWalletBackup(
			new TextEncoder().encode(encrypted),
			"wallet.bep",
		);
		assert.equal(detected.kind, "bitcoin-backup");
		assert.equal(detected.network, null);
		assert.equal(detected.hintedNetwork, null);
		const {
			keys: restored,
			network,
			hintedNetwork,
		} = await decryptWalletBackup(detected, "portable-password");
		assert.equal(network, null);
		assert.equal(hintedNetwork, null);
		assert.equal(restored.payPk, keys.payPk);
		assert.equal(restored.ordPk, keys.ordPk);
		assert.equal(restored.identityPk, keys.identityPk);
	});

	test("scopes migration deferral to the wallet identity", () => {
		assert.notEqual(
			migrationDeferredKey(keys),
			migrationDeferredKey({
				...keys,
				payPk: PrivateKey.fromHex("04".repeat(32)).toWif(),
			}),
		);
	});
});

const testnetWif = (hex: string) => {
	const main = Utils.fromBase58Check(PrivateKey.fromHex(hex).toWif());
	return Utils.toBase58Check(main.data as number[], [0xef]);
};

describe("account network in backups", () => {
	const password = "fixture-password-not-a-secret";

	test("a testnet account carries its network in the envelope and payload", async () => {
		const envelope = await createEncryptedWalletBackup(keys, password, "test");
		assert.equal(envelope.network, "test");
		const decrypted = await decryptEncryptedWalletBackup(envelope, password);
		assert.equal(decrypted.network, "test");
		assert.equal(decrypted.keys.payPk, keys.payPk);

		// The payload alone is enough: a stripped envelope still reads as testnet.
		const { network: _stripped, ...stripped } = envelope;
		assert.equal(
			(await decryptEncryptedWalletBackup(stripped, password)).network,
			"test",
		);
		const detected = detectWalletBackup(
			new TextEncoder().encode(JSON.stringify(envelope)),
			"wallet.json",
		);
		assert.equal(detected.network, "test");
		assert.equal(
			(await decryptWalletBackup(detected, password)).network,
			"test",
		);
		const strippedDetected = detectWalletBackup(
			new TextEncoder().encode(JSON.stringify(stripped)),
			"wallet.json",
		);
		assert.equal(strippedDetected.network, null);
		assert.equal(
			(await decryptWalletBackup(strippedDetected, password)).network,
			"test",
		);
	});

	test("a mainnet account writes no network field anywhere", async () => {
		const envelope = await createEncryptedWalletBackup(keys, password, "main");
		assert.equal(JSON.stringify(envelope).includes("network"), false);
		assert.equal(
			(await decryptEncryptedWalletBackup(envelope, password)).network,
			"main",
		);
		const defaulted = await createEncryptedWalletBackup(keys, password);
		assert.equal("network" in defaulted, false);
	});

	test("unlock repairs a testnet envelope that lost its field", async () => {
		const envelope = await createEncryptedWalletBackup(keys, password, "test");
		const { network: _stripped, ...stripped } = envelope;
		const storage = new MemoryStorage(JSON.stringify(stripped));
		const unlocked = await loadEncryptedWallet(password, storage);
		assert.equal(unlocked?.payPk, keys.payPk);
		const repaired = JSON.parse(storage.value ?? "");
		assert.equal(repaired.network, "test");
		assert.equal(repaired.encryptedBackup, envelope.encryptedBackup);

		// A mainnet envelope is left byte for byte as it was.
		const mainnet = JSON.stringify(
			await createEncryptedWalletBackup(keys, password, "main"),
		);
		const mainStorage = new MemoryStorage(mainnet);
		assert.ok(await loadEncryptedWallet(password, mainStorage));
		assert.equal(mainStorage.value, mainnet);
	});

	test("re-encryption keeps a testnet account on testnet", async () => {
		const envelope = await createEncryptedWalletBackup(keys, password, "test");
		const storage = new MemoryStorage(JSON.stringify(envelope));
		assert.ok(await loadEncryptedWallet(password, storage));
		assert.equal(
			await reencryptWallet({ ...keys, ordAddressPath: "m/0/1" }, storage),
			true,
		);
		const rewritten = parseEncryptedBackupJson(JSON.parse(storage.value ?? ""));
		assert.equal(rewritten.network, "test");
		const decrypted = await decryptEncryptedWalletBackup(rewritten, password);
		assert.equal(decrypted.network, "test");
		assert.equal(decrypted.keys.ordAddressPath, "m/0/1");
	});

	test("rejects any network value other than test", () => {
		const base = {
			encryptedBackup: "ENC:abc",
			pubKey: "02aa",
			format: "1sat-web-wallet",
			version: 1,
			cipher: "AES-256-GCM",
		};
		for (const network of ["main", "regtest", "testnet", 1]) {
			assert.throws(
				() => parseEncryptedBackupJson({ ...base, network }),
				/Invalid 1Sat wallet backup/,
			);
		}
		assert.equal(
			parseEncryptedBackupJson({ ...base, network: "test" }).network,
			"test",
		);
	});

	test("honours a Yours account's network exactly as iOS does", () => {
		const yours = (network?: unknown) =>
			new TextEncoder().encode(
				JSON.stringify({
					version: 6,
					selectedAccount: "a",
					salt: "s",
					accounts: {
						a: {
							encryptedKeys: "v2:00",
							...(network === undefined ? {} : { network }),
						},
						b: { encryptedKeys: "v2:00", network: "testnet" },
					},
				}),
			);
		assert.equal(
			detectWalletBackup(yours("testnet"), "y.json").network,
			"test",
		);
		assert.equal(detectWalletBackup(yours(), "y.json").network, "main");
		assert.equal(
			detectWalletBackup(yours("mainnet"), "y.json").network,
			"main",
		);
		assert.equal(
			detectWalletBackup(yours("Testnet"), "y.json").network,
			"main",
		);
	});

	test("hints testnet only when every visible key is testnet-encoded", async () => {
		const test1 = testnetWif("01".repeat(32));
		const test2 = testnetWif("02".repeat(32));
		assert.equal(wifNetwork(test1), "test");
		assert.equal(wifNetwork(keys.payPk), "main");
		assert.equal(wifNetwork("not a key"), null);
		// Testnet-encoded WIFs are the same keys.
		assert.equal(
			PrivateKey.fromWif(test1).toHex(),
			PrivateKey.fromWif(keys.payPk).toHex(),
		);

		const plaintext = (payPk: string, ordPk: string) =>
			detectWalletBackup(
				new TextEncoder().encode(JSON.stringify({ payPk, ordPk })),
				"keys.json",
			);
		const allTest = plaintext(test1, test2);
		assert.equal(allTest.network, null);
		assert.equal(allTest.hintedNetwork, "test");
		assert.equal(plaintext(test1, keys.ordPk).hintedNetwork, null);
		assert.equal(plaintext(keys.payPk, keys.ordPk).hintedNetwork, null);

		// A .bep shows its keys only after decryption.
		const encrypted = await encryptBackup(
			{
				...keys,
				payPk: test1,
				ordPk: test2,
				identityPk: testnetWif("03".repeat(32)),
			},
			"portable-password",
		);
		const bep = detectWalletBackup(
			new TextEncoder().encode(encrypted),
			"w.bep",
		);
		assert.equal(bep.hintedNetwork, null);
		const restored = await decryptWalletBackup(bep, "portable-password");
		assert.equal(restored.network, null);
		assert.equal(restored.hintedNetwork, "test");
	});
});
