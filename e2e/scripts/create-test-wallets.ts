/**
 * Creates the two throwaway testnet wallets the e2e tests use and writes
 * their encrypted backups and passphrase to .env.e2e.local (gitignored).
 * Prints only public data: deposit addresses and identity keys.
 *
 *   bun run e2e:wallets:create
 */
import { writeFile } from "node:fs/promises";
import { PrivateKey, ProtoWallet } from "@bsv/sdk";
import {
	deriveIdentityKey,
	findKeysFromMnemonic,
	generateMnemonic,
} from "@/lib/keys";
import { deriveReceiveAddress } from "@/lib/receive-address-manager";
import { TESTNET_FAUCET_URL } from "../support/env";
import { ENV_FILE } from "../support/paths";
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
const walletB = await createWallet(passphrase, "wallet B");
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();

const lines = [
	"# Throwaway testnet wallets for the 1satwallet.com e2e tests.",
	"# Created by `bun run e2e:wallets:create`. Never commit or share this file.",
	`E2E_WALLET_A_BACKUP='${walletA.backup}'`,
	`E2E_WALLET_B_BACKUP='${walletB.backup}'`,
	`E2E_WALLET_PASSPHRASE=${passphrase}`,
	bypass
		? `VERCEL_AUTOMATION_BYPASS_SECRET=${bypass}`
		: "# VERCEL_AUTOMATION_BYPASS_SECRET= (add the Vercel Protection Bypass for Automation secret here)",
];

try {
	// "wx": never overwrite an existing file, which may hold funded wallets.
	await writeFile(ENV_FILE, `${lines.join("\n")}\n`, {
		flag: "wx",
		mode: 0o600,
	});
} catch (error) {
	if ((error as NodeJS.ErrnoException).code === "EEXIST") {
		console.error(
			`${ENV_FILE} already exists; nothing was written. It may hold funded test wallets: move it away first if you really want new ones.`,
		);
		process.exit(1);
	}
	throw error;
}

console.log(`Wrote ${ENV_FILE}\n`);
for (const [name, wallet] of [
	["A", walletA],
	["B", walletB],
] as const) {
	console.log(`Wallet ${name}`);
	console.log(`  testnet deposit address: ${wallet.depositAddress}`);
	console.log(`  identity key:            ${wallet.identityKey}`);
}
console.log(
	`\nFund both from ${TESTNET_FAUCET_URL}: about 0.01 tBSV to A and 0.001 tBSV to B.`,
);
