/**
 * Derives the e2e tests' testnet wallet A from the QA root secret, the same
 * way the QA wallets of the other 1Sat test suites are derived, and hands its
 * encrypted backup and passphrase to the e2e tests. No new root or random key
 * is ever made: the same root and label always give the same wallet.
 *
 *   wallet seed = HMAC-SHA256(key: ONESAT_QA_ROOT, message: "web/A")
 *   payPk       = HMAC-SHA256(key: seed, message: "pay")
 *   ordPk       = HMAC-SHA256(key: seed, message: "ord")
 *
 * The keys are bare WIF keys, the shape of an original 1Sat wallet import.
 *
 *   bun run e2e:wallet:derive            writes .env.e2e.local (gitignored)
 *   bun run e2e:wallet:derive --github   sets the e2e-testnet environment's
 *                                        secrets and turns the testnet job on
 *
 * ONESAT_QA_ROOT (32 bytes as 64 hex characters) comes from the environment,
 * or on macOS from the keychain item onesat-qa-root. The root, the keys, the
 * backup and the passphrase are never printed or logged; the script prints
 * only the wallet's identity key and deposit address.
 */
import { execFile, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { PrivateKey, ProtoWallet } from "@bsv/sdk";
import { deriveIdentityKey } from "@/lib/keys";
import { deriveReceiveAddress } from "@/lib/receive-address-manager";
import type { Keys } from "@/lib/types";
import { ENV_FILE } from "../support/env";
import {
	createTestnetBackup,
	openTestnetBackup,
} from "../support/test-network";

const ROOT_ENV = "ONESAT_QA_ROOT";
const KEYCHAIN_ITEM = "onesat-qa-root";
const WALLET_LABEL = "web/A";
const REPO = "opldotdev/1satwallet.com";
const ENVIRONMENT = "e2e-testnet";
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

/** The root from the environment, or the macOS keychain. Errors never quote it. */
async function readRoot(): Promise<Buffer> {
	let text = process.env[ROOT_ENV]?.trim() ?? "";
	if (!text && process.platform === "darwin") {
		try {
			const { stdout } = await promisify(execFile)("security", [
				"find-generic-password",
				"-s",
				KEYCHAIN_ITEM,
				"-w",
			]);
			text = stdout.trim();
		} catch (error) {
			const stderr = (error as { stderr?: string }).stderr?.trim();
			throw new Error(
				`${ROOT_ENV} is unset and reading the keychain item ${KEYCHAIN_ITEM} failed${stderr ? `: ${stderr}` : "."}`,
			);
		}
	}
	if (!text) {
		throw new Error(
			`${ROOT_ENV} is not set (and there is no macOS keychain to read it from).`,
		);
	}
	if (!/^[0-9a-fA-F]{64}$/.test(text)) {
		throw new Error(
			`${ROOT_ENV} is not 32 bytes as 64 hex characters (${text.length} characters given).`,
		);
	}
	return Buffer.from(text, "hex");
}

const hmac = (key: Buffer, message: string) =>
	createHmac("sha256", key).update(message, "utf8").digest();

/** A WIF private key from 32 bytes; refuses the (astronomically rare) invalid scalar. */
function wifFrom(bytes: Buffer, name: string): string {
	const key = PrivateKey.fromString(bytes.toString("hex"), "hex");
	if (key.toHex() !== bytes.toString("hex") || key.isZero()) {
		throw new Error(`The derived ${name} key is not a valid private key.`);
	}
	return key.toWif();
}

/** The wallet's keys, exactly as the app keeps an imported pair of WIF keys. */
function deriveKeys(root: Buffer): Keys {
	const seed = hmac(root, WALLET_LABEL);
	const keys: Keys = {
		payPk: wifFrom(hmac(seed, "pay"), "pay"),
		ordPk: wifFrom(hmac(seed, "ord"), "ordinals"),
	};
	keys.identityPk = deriveIdentityKey(keys.payPk, keys.ordPk).toWif();
	keys.identityAddressPath = "derived";
	return keys;
}

/** Runs gh with `input` on stdin, so a secret never appears in argv or a log. */
function gh(args: string[], input?: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("gh", args, {
			stdio: [input === undefined ? "ignore" : "pipe", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) =>
			reject(new Error(`Could not run gh: ${error.message}`)),
		);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else
				reject(
					new Error(
						`gh ${args.slice(0, 3).join(" ")} failed (exit ${code}): ${stderr.trim()}`,
					),
				);
		});
		if (input !== undefined) child.stdin?.end(input);
	});
}

async function setGitHubSecrets(backup: string, passphrase: string) {
	// Creates the environment if it is missing; changes nothing if it exists.
	await gh([
		"api",
		"--method",
		"PUT",
		`repos/${REPO}/environments/${ENVIRONMENT}`,
		"--silent",
	]);
	await gh(
		["secret", "set", "E2E_WALLET_A_BACKUP", "--env", ENVIRONMENT, "-R", REPO],
		backup,
	);
	await gh(
		[
			"secret",
			"set",
			"E2E_WALLET_PASSPHRASE",
			"--env",
			ENVIRONMENT,
			"-R",
			REPO,
		],
		passphrase,
	);
	await gh([
		"variable",
		"set",
		"E2E_TESTNET_ENABLED",
		"--body",
		"true",
		"-R",
		REPO,
	]);
}

async function writeEnvFile(backup: string, passphrase: string) {
	const lines = [
		`# Testnet wallet A for the 1satwallet.com e2e tests, derived from ${ROOT_ENV} ("${WALLET_LABEL}").`,
		"# Written by `bun run e2e:wallet:derive`. Never commit or share this file.",
		`E2E_WALLET_A_BACKUP='${backup}'`,
		`E2E_WALLET_PASSPHRASE=${passphrase}`,
	];
	try {
		// "wx": never overwrite an existing file, which may hold another wallet.
		await writeFile(ENV_FILE, `${lines.join("\n")}\n`, {
			flag: "wx",
			mode: 0o600,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(
				`${ENV_FILE} already exists; nothing was written. Move it away first if you want it replaced.`,
			);
		}
		throw error;
	}
}

const toGitHub = process.argv.includes("--github");
const keys = deriveKeys(await readRoot());
const passphrase = randomPassphrase();
const backup = await createTestnetBackup(keys, passphrase);
// Read it back through the same guard the tests use.
const { identityKey } = await openTestnetBackup(backup, passphrase, "wallet A");
const { address } = await deriveReceiveAddress({
	wallet: new ProtoWallet(PrivateKey.fromWif(keys.identityPk as string)),
	chain: "test",
	identityKey,
	index: 0,
});

if (toGitHub) {
	await setGitHubSecrets(backup, passphrase);
	console.log(
		`Set ${ENVIRONMENT} secrets E2E_WALLET_A_BACKUP and E2E_WALLET_PASSPHRASE and E2E_TESTNET_ENABLED=true on ${REPO}.\n`,
	);
} else {
	await writeEnvFile(backup, passphrase);
	console.log(`Wrote ${ENV_FILE}\n`);
}
console.log(`Wallet A ("${WALLET_LABEL}")`);
console.log(`  testnet deposit address: ${address}`);
console.log(`  identity key:            ${identityKey}`);
