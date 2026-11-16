/**
 * Creates the throwaway testnet wallet the e2e tests use (wallet A) and
 * writes its encrypted backup and passphrase to .env.e2e.local (gitignored).
 * Prints only public data: its deposit address and identity key.
 *
 *   bun run e2e:wallet:create
 */
import { writeFile } from "node:fs/promises";
import { PrivateKey, ProtoWallet } from "@bsv/sdk";
import {
	deriveIdentityKey,
	findKeysFromMnemonic,
	generateMnemonic,
} from "@/lib/keys";
import { deriveReceiveAddress } from "@/lib/receive-address-manager";
import { ENV_FILE, TESTNET_FAUCET_URL } from "../support/env";
import {
	createTestnetBackup,
	openTestnetBackup,
} from "../support/test-network";

const PASSPHRASE_LENGTH = 32;
const ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Uniform random alphanumeric passphrase (rejection sampling, no bias). */
function randomPassphrase(): string {
	const limit = 256 - (256 % ALPHABET.length);
	let result = "";
	while (result.length < PASSPHRASE_LENGTH) {
		for (const byte of crypto.getRandomValues(new Uint8Array(64))) {
			if (byte < limit && result.length < PASSPHRASE_LENGTH) {
				result += ALPHABET[byte % ALPHABET.length];
			}
		}
	}
	return result;
}

interface TestWallet {
	backup: string;
	identityKey: string;
	depositAddress: string;
}

/** The same key setup as the app's create flow, saved as a testnet account. */
async function createWallet(
	passphrase: string,
	label: string,
): Promise<TestWallet> {
	const keys = await findKeysFromMnemonic(generateMnemonic());
	keys.identityPk = deriveIdentityKey(keys.payPk, keys.ordPk).toWif();
	keys.identityAddressPath = "derived";
	const backup = await createTestnetBackup(keys, passphrase);
	// Read it back through the same guard the tests use.
	const { identityKey } = await openTestnetBackup(backup, passphrase, label);

	// The first deposit address the app shows: BRC-29 index 0 of the root key.
	const root = PrivateKey.fromWif(keys.identityPk);
	const { address } = await deriveReceiveAddress({
		wallet: new ProtoWallet(root),
		chain: "test",
		identityKey,
		index: 0,
	});
	return { backup, identityKey, depositAddress: address };
}

const passphrase = randomPassphrase();
const walletA = await createWallet(passphrase, "wallet A");

const lines = [
	"# Throwaway testnet wallet for the 1satwallet.com e2e tests.",
	"# Created by `bun run e2e:wallet:create`. Never commit or share this file.",
	`E2E_WALLET_A_BACKUP='${walletA.backup}'`,
	`E2E_WALLET_PASSPHRASE=${passphrase}`,
];

try {
	// "wx": never overwrite an existing file, which may hold a funded wallet.
	await writeFile(ENV_FILE, `${lines.join("\n")}\n`, {
		flag: "wx",
		mode: 0o600,
	});
} catch (error) {
	if ((error as NodeJS.ErrnoException).code === "EEXIST") {
		console.error(
			`${ENV_FILE} already exists; nothing was written. It may hold a funded test wallet: move it away first if you really want a new one.`,
		);
		process.exit(1);
	}
	throw error;
}

console.log(`Wrote ${ENV_FILE}\n`);
console.log("Wallet A");
console.log(`  testnet deposit address: ${walletA.depositAddress}`);
console.log(`  identity key:            ${walletA.identityKey}`);
console.log(`\nFund it from ${TESTNET_FAUCET_URL}: about 0.01 tBSV.`);
