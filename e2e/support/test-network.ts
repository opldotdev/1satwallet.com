import { PrivateKey } from "@bsv/sdk";
import type { Keys } from "@/lib/types";
import {
	createEncryptedWalletBackup,
	decryptEncryptedWalletBackup,
	type EncryptedBackupJson,
	parseEncryptedBackupJson,
} from "@/lib/wallet-storage";

/*
 * The only e2e code that depends on the per-account network: the envelope's
 * `network: "test"` field and `createEncryptedWalletBackup(..., "test")`.
 */

/** The app's own v1 envelope for a testnet account, serialized on one line. */
export async function createTestnetBackup(
	keys: Keys,
	passphrase: string,
): Promise<string> {
	return JSON.stringify(
		await createEncryptedWalletBackup(keys, passphrase, "test"),
	);
}

export interface OpenedTestnetBackup {
	keys: Keys;
	/** BRC-100 identity key (public), as the app derives it. */
	identityKey: string;
}

/**
 * Decrypts a serialized envelope and refuses it unless both the envelope and
 * the encrypted payload say testnet. `label` names the setting in errors.
 */
export async function openTestnetBackup(
	serialized: string,
	passphrase: string,
	label: string,
): Promise<OpenedTestnetBackup> {
	let envelope: EncryptedBackupJson;
	try {
		envelope = parseEncryptedBackupJson(JSON.parse(serialized));
	} catch (error) {
		throw new Error(`${label} is not a 1Sat web wallet backup envelope.`, {
			cause: error,
		});
	}
	if (envelope.network !== "test") {
		throw new Error(
			`Refusing to run: ${label} does not say network "test". Only throwaway testnet wallets may be used.`,
		);
	}

	// The envelope field is not authenticated; drop it so the result reports
	// what the encrypted payload itself says.
	let payload: Awaited<ReturnType<typeof decryptEncryptedWalletBackup>>;
	try {
		payload = await decryptEncryptedWalletBackup(
			{ ...envelope, network: undefined },
			passphrase,
		);
	} catch (error) {
		throw new Error(
			`${label} could not be decrypted with E2E_WALLET_PASSPHRASE.`,
			{ cause: error },
		);
	}
	if (payload.network !== "test") {
		throw new Error(
			`Refusing to run: the encrypted payload of ${label} does not say network "test".`,
		);
	}

	const rootWif = payload.keys.identityPk ?? payload.keys.payPk;
	return {
		keys: payload.keys,
		identityKey: PrivateKey.fromWif(rootWif).toPublicKey().toString(),
	};
}
