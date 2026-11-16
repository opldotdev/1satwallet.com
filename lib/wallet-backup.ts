import { PrivateKey, Utils } from "@bsv/sdk";
import {
	decryptBackup,
	isOneSatBackup,
	isYoursWalletBackup,
	parseYoursWalletZip,
} from "bitcoin-backup";
import type { Chain } from "@/lib/chain-endpoints";
import type { Keys } from "@/lib/types";
import {
	decryptEncryptedWalletBackup,
	type EncryptedBackupJson,
	parseEncryptedBackupJson,
} from "@/lib/wallet-storage";

type JsonObject = Record<string, unknown>;

/**
 * Every variant says which network the file names (null: it does not say, so
 * the person chooses) and whether its visible keys hint at testnet.
 */
interface NetworkInfo {
	network: Chain | null;
	hintedNetwork: "test" | null;
}

export type DetectedWalletBackup = NetworkInfo &
	(
		| {
				kind: "1sat-web";
				version: 0 | 1;
				label: string;
				requiresPassword: true;
				backup: EncryptedBackupJson;
		  }
		| {
				kind: "bitcoin-backup";
				version: 1;
				label: string;
				requiresPassword: true;
				encrypted: string;
		  }
		| {
				kind: "yours-keys";
				version: 1 | 6;
				archiveVersion: 0 | 1 | 2;
				label: string;
				requiresPassword: boolean;
				chromeStorage: JsonObject;
		  }
		| {
				kind: "plaintext-keys";
				version: 0;
				label: string;
				requiresPassword: false;
				keys: Keys;
		  }
	);

function object(value: unknown): JsonObject | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: null;
}

function validWif(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		PrivateKey.fromWif(value);
		return true;
	} catch {
		return false;
	}
}

/** The chain a WIF is encoded for (version byte 0x80 or 0xef), else null. */
export function wifNetwork(wif: string): Chain | null {
	if (!validWif(wif)) return null;
	const version = Utils.fromBase58(wif)[0];
	return version === 0x80 ? "main" : version === 0xef ? "test" : null;
}

/** Testnet only when every key is testnet-encoded; otherwise no hint. */
export function keysNetworkHint(keys: Keys): "test" | null {
	const wifs = [keys.payPk, keys.ordPk, keys.identityPk].filter(
		(wif): wif is string => typeof wif === "string",
	);
	return wifs.length > 0 && wifs.every((wif) => wifNetwork(wif) === "test")
		? "test"
		: null;
}

/** Yours `chainOf`: only exactly "testnet" is testnet. */
function yoursNetwork(storage: JsonObject): Chain {
	const accounts = object(storage.accounts);
	const selected = storage.selectedAccount;
	const account =
		accounts && typeof selected === "string"
			? object(accounts[selected])
			: null;
	return account?.network === "testnet" ? "test" : "main";
}

function keysFromPortable(value: unknown, identityRequired: boolean): Keys {
	const source = object(value);
	if (!source || !validWif(source.payPk) || !validWif(source.ordPk)) {
		throw new Error("Backup is missing valid payment or ordinal keys");
	}
	if (identityRequired && !validWif(source.identityPk)) {
		throw new Error("Backup is missing a valid identity key");
	}
	if (source.identityPk !== undefined && !validWif(source.identityPk)) {
		throw new Error("Backup has an invalid identity key");
	}
	return {
		payPk: source.payPk,
		ordPk: source.ordPk,
		identityPk:
			typeof source.identityPk === "string" ? source.identityPk : undefined,
		mnemonic: typeof source.mnemonic === "string" ? source.mnemonic : undefined,
		changeAddressPath:
			typeof source.payDerivationPath === "string"
				? source.payDerivationPath
				: undefined,
		ordAddressPath:
			typeof source.ordDerivationPath === "string"
				? source.ordDerivationPath
				: undefined,
		identityAddressPath:
			typeof source.identityDerivationPath === "string"
				? source.identityDerivationPath
				: undefined,
	};
}

function chromeStorage(value: unknown): JsonObject {
	const storage = object(value);
	const accounts = object(storage?.accounts);
	if (!storage || !accounts || Object.keys(accounts).length === 0) {
		throw new Error("Yours backup contains no accounts");
	}
	if (
		typeof storage.selectedAccount !== "string" ||
		!object(accounts[storage.selectedAccount])
	) {
		throw new Error("Yours backup has no valid selected account");
	}
	return storage;
}

function detectYoursZip(bytes: Uint8Array): DetectedWalletBackup {
	const parsed = parseYoursWalletZip(bytes);
	const storage = chromeStorage(parsed.chromeStorage);
	const manifest = parsed.manifest;
	if (manifest) {
		if (manifest.version !== 1 && manifest.version !== 2) {
			throw new Error("Unsupported Yours backup manifest version");
		}
		if (
			(manifest.version === 1 &&
				(typeof manifest.identityKey !== "string" ||
					!Number.isSafeInteger(manifest.chunkCount) ||
					manifest.chunkCount < 0)) ||
			(manifest.version === 2 &&
				(!Array.isArray(manifest.accounts) ||
					manifest.accounts.some(
						(account) =>
							typeof account.identityKey !== "string" ||
							typeof account.identityAddress !== "string" ||
							!Number.isSafeInteger(account.chunkCount) ||
							account.chunkCount < 0,
					)))
		) {
			throw new Error("Invalid Yours backup manifest");
		}
		const expectedChunks =
			manifest.version === 1
				? manifest.chunkCount
				: manifest.accounts.reduce(
						(total, account) => total + account.chunkCount,
						0,
					);
		if (
			parsed.settings === undefined ||
			Object.keys(parsed.chunks ?? {}).length !== expectedChunks
		) {
			throw new Error("Yours backup is incomplete");
		}
	}

	const version = storage.version;
	if (version !== 1 && version !== 6) {
		throw new Error("Unsupported Yours key backup version");
	}
	return {
		kind: "yours-keys",
		version,
		archiveVersion: manifest?.version ?? 0,
		label:
			version === 6 ? "Yours Wallet keys v6" : "Yours Wallet legacy keys v1",
		requiresPassword:
			typeof storage.passKey !== "string" || storage.passKey.length === 0,
		chromeStorage: storage,
		network: yoursNetwork(storage),
		hintedNetwork: null,
	};
}

const BITCOIN_BACKUP = /^[A-Za-z0-9+/]+={0,2}$/;

export function detectWalletBackup(
	bytes: Uint8Array,
	fileName: string,
): DetectedWalletBackup {
	if (bytes.length > 16 * 1024 * 1024) {
		throw new Error("Wallet backup exceeds the 16 MiB import limit");
	}
	if (bytes[0] === 0x50 && bytes[1] === 0x4b) return detectYoursZip(bytes);

	const text = new TextDecoder().decode(bytes).trim();
	if (!text) throw new Error("Backup file is empty");
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		if (
			!fileName.toLowerCase().endsWith(".bep") ||
			text.length < 64 ||
			!BITCOIN_BACKUP.test(text)
		) {
			throw new Error("Unsupported wallet backup file");
		}
		return {
			kind: "bitcoin-backup",
			version: 1,
			label: "bitcoin-backup encrypted file",
			requiresPassword: true,
			encrypted: text,
			network: null,
			hintedNetwork: null,
		};
	}

	if (typeof value === "string") {
		if (value.length < 64 || !BITCOIN_BACKUP.test(value)) {
			throw new Error("Invalid bitcoin-backup payload");
		}
		return {
			kind: "bitcoin-backup",
			version: 1,
			label: "bitcoin-backup encrypted file",
			requiresPassword: true,
			encrypted: value,
			network: null,
			hintedNetwork: null,
		};
	}

	const root = object(value);
	if (!root) throw new Error("Unsupported wallet backup file");
	if (root.encryptedBackup !== undefined || root.pubKey !== undefined) {
		const backup = parseEncryptedBackupJson(root);
		return {
			kind: "1sat-web",
			version: backup.format === "1sat-web-wallet" ? 1 : 0,
			label:
				backup.format === "1sat-web-wallet"
					? "1Sat web wallet backup v1"
					: "1Sat web wallet legacy backup",
			requiresPassword: true,
			backup,
			// A file without the field may predate it, so it is not mainnet yet.
			network: backup.network === "test" ? "test" : null,
			hintedNetwork: null,
		};
	}
	if (root.accounts !== undefined) {
		const storage = chromeStorage(root);
		const version = storage.version;
		if (version !== 1 && version !== 6) {
			throw new Error("Unsupported Yours key backup version");
		}
		return {
			kind: "yours-keys",
			version,
			archiveVersion: 0,
			label:
				version === 6 ? "Yours Wallet keys v6" : "Yours Wallet legacy keys v1",
			requiresPassword:
				typeof storage.passKey !== "string" || storage.passKey.length === 0,
			chromeStorage: storage,
			network: yoursNetwork(storage),
			hintedNetwork: null,
		};
	}
	if (root.payPk !== undefined || root.ordPk !== undefined) {
		const keys = keysFromPortable(root, false);
		return {
			kind: "plaintext-keys",
			version: 0,
			label: "Legacy plaintext wallet keys",
			requiresPassword: false,
			keys,
			network: null,
			hintedNetwork: keysNetworkHint(keys),
		};
	}
	throw new Error("Unsupported wallet backup file");
}

function hex(value: string): Uint8Array {
	if (value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) {
		throw new Error("Invalid encrypted key data");
	}
	return Uint8Array.from(
		value.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
	);
}

async function deriveKey(
	password: string,
	salt: Uint8Array,
	iterations: number,
): Promise<Uint8Array> {
	const material = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	return new Uint8Array(
		await crypto.subtle.deriveBits(
			{
				name: "PBKDF2",
				hash: "SHA-256",
				salt: salt as BufferSource,
				iterations,
			},
			material,
			256,
		),
	);
}

async function decryptYoursKeys(
	storage: JsonObject,
	password: string,
): Promise<Keys> {
	const accounts = object(storage.accounts);
	const selected = storage.selectedAccount;
	if (!accounts || typeof selected !== "string") {
		throw new Error("Yours backup has no selected account");
	}
	const account = object(accounts[selected]);
	if (!account || typeof account.encryptedKeys !== "string") {
		throw new Error("Yours backup account has no encrypted keys");
	}

	let passKey: Uint8Array;
	if (typeof storage.passKey === "string" && storage.passKey.length > 0) {
		passKey = hex(storage.passKey);
	} else {
		if (typeof storage.salt !== "string" || storage.salt.length === 0) {
			throw new Error("Yours backup has no encryption salt");
		}
		passKey = await deriveKey(
			password,
			new TextEncoder().encode(storage.salt),
			100_000,
		);
	}
	if (passKey.length !== 32) throw new Error("Yours backup has an invalid key");

	const encrypted = account.encryptedKeys;
	let plaintext: ArrayBuffer;
	if (encrypted.startsWith("v2:")) {
		const payload = hex(encrypted.slice(3));
		if (payload.length <= 28) throw new Error("Invalid Yours v2 key data");
		const key = await crypto.subtle.importKey(
			"raw",
			passKey as BufferSource,
			"AES-GCM",
			false,
			["decrypt"],
		);
		plaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: payload.slice(0, 12) as BufferSource },
			key,
			payload.slice(12) as BufferSource,
		);
	} else {
		if (encrypted.length <= 64)
			throw new Error("Invalid Yours legacy key data");
		const salt = hex(encrypted.slice(0, 32));
		const iv = hex(encrypted.slice(32, 64));
		const body = Uint8Array.from(atob(encrypted.slice(64)), (character) =>
			character.charCodeAt(0),
		);
		const passKeyHex = Array.from(passKey, (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		const keyBytes = await deriveKey(passKeyHex, salt, 1_000);
		const key = await crypto.subtle.importKey(
			"raw",
			keyBytes as BufferSource,
			"AES-CBC",
			false,
			["decrypt"],
		);
		plaintext = await crypto.subtle.decrypt(
			{ name: "AES-CBC", iv: iv as BufferSource },
			key,
			body as BufferSource,
		);
	}

	const yours = object(
		JSON.parse(new TextDecoder().decode(plaintext)) as unknown,
	);
	if (!yours) throw new Error("Yours backup keys are invalid");
	return keysFromPortable(
		{
			payPk: yours.walletWif,
			ordPk: yours.ordWif,
			identityPk: yours.identityWif,
			mnemonic: yours.mnemonic,
			payDerivationPath: yours.walletDerivationPath,
			ordDerivationPath: yours.ordDerivationPath,
			identityDerivationPath: yours.identityDerivationPath,
		},
		true,
	);
}

export interface DecryptedWalletBackup {
	keys: Keys;
	/** The network the backup names, or null when the person must choose. */
	network: Chain | null;
	hintedNetwork: "test" | null;
}

async function decryptKeys(
	backup: DetectedWalletBackup,
	password: string,
): Promise<{ keys: Keys; network: Chain | null }> {
	switch (backup.kind) {
		case "1sat-web": {
			const { keys, network } = await decryptEncryptedWalletBackup(
				backup.backup,
				password,
			);
			// The authenticated payload's "test" wins over a file that says nothing.
			return { keys, network: network === "test" ? "test" : backup.network };
		}
		case "bitcoin-backup": {
			const decrypted = await decryptBackup(backup.encrypted, password);
			if (!isOneSatBackup(decrypted) && !isYoursWalletBackup(decrypted)) {
				throw new Error("Encrypted backup is not a 1Sat or Yours key backup");
			}
			return { keys: keysFromPortable(decrypted, true), network: null };
		}
		case "yours-keys":
			return {
				keys: await decryptYoursKeys(backup.chromeStorage, password),
				network: backup.network,
			};
		case "plaintext-keys":
			return { keys: backup.keys, network: null };
	}
}

export async function decryptWalletBackup(
	backup: DetectedWalletBackup,
	password: string,
): Promise<DecryptedWalletBackup> {
	const { keys, network } = await decryptKeys(backup, password);
	return {
		keys,
		network,
		hintedNetwork: network === null ? keysNetworkHint(keys) : null,
	};
}
