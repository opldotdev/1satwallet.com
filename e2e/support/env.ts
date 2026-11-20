import { readFileSync } from "node:fs";
import path from "node:path";
import { endpointsOf } from "@/lib/chain-endpoints";
import { openTestnetBackup } from "./test-network";

/** Local secrets written by `bun run e2e:wallet:create` (gitignored). */
export const ENV_FILE = path.join(__dirname, "..", "..", ".env.e2e.local");

/** Failure screenshots, taken only after the passphrase field is cleared. */
export const ARTIFACTS_DIR = path.join(__dirname, "..", "..", "e2e-artifacts");

export const TESTNET_FAUCET_URL = endpointsOf("test").faucet;

/** A URL's host; a bare domain (such as `handleDomain`) is already one. */
const hostOf = (url: string) => (url.includes("://") ? new URL(url).host : url);

/** Mainnet backends a testnet account must never call. */
export const MAINNET_ONLY_HOSTS = [
	endpointsOf("main").storage,
	endpointsOf("main").messagebox,
].map(hostOf);

/** Testnet backends a mainnet visitor must never call. */
export const TESTNET_HOSTS = Object.values(endpointsOf("test"))
	.filter((url): url is string => typeof url === "string")
	.map(hostOf);

/**
 * One installation id for every run, so the testnet storage server sees the
 * same installation instead of a new one per fresh browser context.
 */
export const E2E_INSTALLATION_ID =
	"1sat-web-6f0c2a4e-3b1d-4c8e-9a72-5d1e0b7c4f36";

const SETUP_HINT =
	'E2E_BASE_URL is the site under test, e.g. http://localhost:3000 after "bun run build && bun run start". For the wallet settings, run "bun run e2e:wallet:create" locally (writes .env.e2e.local); in CI they are secrets of the GitHub environment "e2e-testnet".';

/**
 * The wallet settings `bun run e2e` hands to bun test in a mode 600 file
 * named by E2E_SECRETS_FILE, so they are not in the environment of any
 * process the tests start.
 */
let secretsFile: Record<string, string> | undefined;

function setting(name: string): string | undefined {
	const file = process.env.E2E_SECRETS_FILE;
	if (file) {
		secretsFile ??= JSON.parse(readFileSync(file, "utf8")) as Record<
			string,
			string
		>;
		if (secretsFile[name]) return secretsFile[name].trim();
	}
	return process.env[name]?.trim() || undefined;
}

/** Reads the named settings, failing once with every missing name. */
export function requireEnv<const Name extends string>(
	names: readonly Name[],
): Record<Name, string> {
	const missing = names.filter((name) => !setting(name));
	if (missing.length > 0) {
		throw new Error(
			`Missing e2e settings: ${missing.join(", ")}. ${SETUP_HINT}`,
		);
	}
	return Object.fromEntries(
		names.map((name) => [name, setting(name) ?? ""]),
	) as Record<Name, string>;
}

/** The site under test, from E2E_BASE_URL (CI: the local `next start`). */
export function baseUrl(): URL {
	const { E2E_BASE_URL } = requireEnv(["E2E_BASE_URL"]);
	let url: URL;
	try {
		url = new URL(E2E_BASE_URL);
	} catch (error) {
		throw new Error(`E2E_BASE_URL is not a URL: ${E2E_BASE_URL}`, {
			cause: error,
		});
	}
	const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
	if (url.protocol !== "https:" && !local) {
		throw new Error(`E2E_BASE_URL must be https: ${E2E_BASE_URL}`);
	}
	return url;
}

export interface TestWallet {
	/** The encrypted 1sat-web-wallet envelope, as stored in localStorage. */
	backup: string;
	passphrase: string;
	identityKey: string;
}

let walletA: Promise<TestWallet> | undefined;

/**
 * Wallet A from E2E_WALLET_A_BACKUP and E2E_WALLET_PASSPHRASE. Refuses to
 * return anything unless both the envelope and its decrypted payload say
 * testnet, so no test can ever unlock a mainnet key.
 */
export function testWalletA(): Promise<TestWallet> {
	walletA ??= (async () => {
		const env = requireEnv(["E2E_WALLET_A_BACKUP", "E2E_WALLET_PASSPHRASE"]);
		const { identityKey } = await openTestnetBackup(
			env.E2E_WALLET_A_BACKUP,
			env.E2E_WALLET_PASSPHRASE,
			"E2E_WALLET_A_BACKUP",
		);
		return {
			backup: env.E2E_WALLET_A_BACKUP,
			passphrase: env.E2E_WALLET_PASSPHRASE,
			identityKey,
		};
	})();
	return walletA;
}
