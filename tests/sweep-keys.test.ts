import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HD, Mnemonic, PrivateKey } from "@bsv/sdk";
import { encryptBackup } from "bitcoin-backup";
import { deriveIdentityKey } from "@/lib/keys";
import {
	keysFromBackupPayload,
	keysFromPhrase,
	readSweepFile,
	readSweepText,
	unlockSweepBackup,
} from "@/lib/wallet/sweep-keys";

const PHRASE =
	"abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const wif = PrivateKey.fromHex("03".repeat(32)).toWif();
const payPk = PrivateKey.fromHex("01".repeat(32)).toWif();
const ordPk = PrivateKey.fromHex("02".repeat(32)).toWif();
const address = (w: string) => PrivateKey.fromWif(w).toPublicKey().toAddress();
const encode = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value));

describe("sweep key input: WIF", () => {
	it("reads a pasted WIF as the key and the identity a 1Sat wallet derives from it", async () => {
		const input = await readSweepText(`  ${wif}\n`);
		assert.equal(input.kind, "keys");
		if (input.kind !== "keys") return;
		assert.equal(input.source, "WIF");
		assert.deepEqual(
			input.keys.map((k) => k.address),
			[address(wif), deriveIdentityKey(wif, wif).toPublicKey().toAddress()],
		);
		assert.equal(input.keys[0].wif, wif);
	});

	it("rejects a WIF with a bad checksum", async () => {
		await assert.rejects(
			readSweepText(`${wif.slice(0, -1)}${wif.endsWith("1") ? "2" : "1"}`),
			/not a WIF, a key backup or a recovery phrase/,
		);
	});
});

describe("sweep key input: WifBackup", () => {
	it("reads a plain WifBackup file", async () => {
		const input = await readSweepFile(
			encode({ wif, label: "paper" }),
			"k.json",
		);
		assert.equal(input.kind, "keys");
		if (input.kind !== "keys") return;
		assert.equal(input.keys[0].address, address(wif));
	});

	it("reads an encrypted WifBackup after its password", async () => {
		const encrypted = await encryptBackup({ wif }, "pw-123456");
		const input = await readSweepFile(
			new TextEncoder().encode(encrypted),
			"key.bep",
		);
		assert.equal(input.kind, "needs-password");
		if (input.kind !== "needs-password") return;
		const keys = await unlockSweepBackup(input.backup, "pw-123456");
		assert.equal(keys[0].address, address(wif));
		await assert.rejects(unlockSweepBackup(input.backup, "wrong-password"));
	});

	it("reads a pay/ord backup without an identity key (original 1Sat)", () => {
		const keys = keysFromBackupPayload({ payPk, ordPk });
		assert.deepEqual(
			keys.map((k) => [k.label, k.address]),
			[
				["Payment key", address(payPk)],
				["Ordinals key", address(ordPk)],
				[
					"Derived identity key",
					deriveIdentityKey(payPk, ordPk).toPublicKey().toAddress(),
				],
			],
		);
	});

	it("refuses a payload with no key", () => {
		assert.throws(() => keysFromBackupPayload({ label: "x" }), /no WIF/);
	});
});

describe("sweep key input: recovery phrase", () => {
	it("derives BIP32/39 keys correctly (known m/44'/0'/0'/0/0 vector)", () => {
		const root = HD.fromSeed(Mnemonic.fromString(PHRASE).toSeed());
		assert.equal(
			root.derive("m/44'/0'/0'/0/0").privKey.toPublicKey().toAddress(),
			"1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA",
		);
	});

	it("sweeps a phrase at the RelayX path m/44'/236'/0'/0/0 only", async () => {
		const input = await readSweepText(`  ${PHRASE.toUpperCase()} `);
		assert.equal(input.kind, "keys");
		if (input.kind !== "keys") return;
		assert.deepEqual(
			input.keys.map((k) => [k.address, k.wif]),
			[
				[
					"1K6LZdwpKT5XkEZo2T2kW197aMXYbYMc4f",
					"KxU83MzcLXP1WJtoFJXMDMcN3z5ykAa9xLdFTDY5XpV4e6Zit9BA",
				],
			],
		);
	});

	it("adds the RelayX path of a backup's phrase to its pay/ord keys", () => {
		const keys = keysFromBackupPayload({ payPk, ordPk, mnemonic: PHRASE });
		assert.equal(keys.at(-1)?.address, keysFromPhrase(PHRASE)[0].address);
		assert.equal(keys.length, 4);
	});

	it("rejects a phrase with a bad checksum", async () => {
		await assert.rejects(
			readSweepText(PHRASE.replace(/about$/, "abandon")),
			/recovery phrase is not valid/,
		);
	});
});
