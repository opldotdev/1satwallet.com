import { openTestnetBackup } from "./test-network";

/*
 * Copies of values in lib/chain-endpoints.ts, which the Playwright runner
 * cannot load (it imports the ESM-only @1sat/types from CommonJS).
 * tests/e2e-test-network.test.ts keeps them equal to endpointsOf().
 */
export const TESTNET_FAUCET_URL = "https://faucet.bananablocks.com";
/** Mainnet backends a testnet account must never call. */
export const MAINNET_ONLY_HOSTS = ["wallet.1sat.app", "messagebox.1sat.app"];

/**
 * One installation id for every run, so the testnet storage server sees the
 * same installation instead of a new one per fresh browser context.
 */
export const E2E_INSTALLATION_ID =
	"1sat-web-6f0c2a4e-3b1d-4c8e-9a72-5d1e0b7c4f36";

const SETUP_HINT =
	'Locally: run "bun run e2e:wallets:create" (writes .env.e2e.local). In CI: set them as secrets of the GitHub environment "e2e-testnet".';

/** Reads the named settings, failing once with every missing name. */
export function requireEnv<const Name extends string>(
	names: readonly Name[],
): Record<Name, string> {
	const missing = names.filter((name) => !process.env[name]?.trim());
	if (missing.length > 0) {
		throw new Error(
			`Missing e2e settings: ${missing.join(", ")}. ${SETUP_HINT}`,
		);
	}
	return Object.fromEntries(
		names.map((name) => [name, process.env[name]?.trim() ?? ""]),
	) as Record<Name, string>;
}

/** The deployed site under test, from E2E_BASE_URL. */
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
