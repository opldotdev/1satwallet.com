"use client";

// SECURITY WARNING: This file handles wallet encryption and storage.
// It is designed for CLIENT-SIDE use only (localStorage/sessionStorage).
// Never attempt to run this logic on the server.

import { PrivateKey, Utils } from "@bsv/sdk";
import { useCallback, useEffect, useState } from "react";
import type { Chain } from "@/lib/chain-endpoints";
import { ENCRYPTION_PREFIX, WALLET_STORAGE_KEY } from "@/lib/constants";
import {
	decryptData,
	generateEncryptionKeyFromPassphrase,
} from "@/lib/encryption";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import type { Keys } from "@/lib/types";
import { refreshWalletChain, walletStoredAfter } from "@/lib/wallet-chain";

export interface EncryptedBackupJson {
	format?: "1sat-web-wallet";
	version?: 1;
	cipher?: "AES-256-GCM";
	encryptedBackup: string;
	pubKey: string; // The public key used as salt
	/**
	 * Present only for a testnet account; absent means mainnet (the iOS
	 * encoding). Fixed at create or import. The same field is inside the
	 * encrypted payload, so the network travels with every backup.
	 */
	network?: "test";
}

/** Envelope or payload network field: only testnet is ever written. */
const networkField = (network: Chain): { network?: "test" } =>
	network === "test" ? { network: "test" } : {};

type WalletStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const getLocalStorage = (): Storage | undefined => {
	if (typeof window !== "undefined") {
		return window.localStorage;
	}
	return undefined;
};

// --- Encryption Key Cache (for migration re-encryption) ---
let cachedEncryptionKey: Uint8Array | null = null;
let cachedPubKeySalt: string | null = null;
/** The account's network as resolved at unlock or save, kept with the key. */
let cachedNetwork: Chain | null = null;

export function clearCachedEncryptionKey(): void {
	cachedEncryptionKey = null;
	cachedPubKeySalt = null;
	cachedNetwork = null;
}

/** The wallet decrypted, but its saved data could not be updated. */
export class WalletSaveError extends Error {
	constructor(cause: unknown) {
		super(
			"Couldn't update this wallet's saved data. Free some browser storage and try again.",
			{ cause },
		);
		this.name = "WalletSaveError";
	}
}

export function parseEncryptedBackupJson(value: unknown): EncryptedBackupJson {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid 1Sat wallet backup");
	}
	const backup = value as Record<string, unknown>;
	if (
		typeof backup.encryptedBackup !== "string" ||
		!backup.encryptedBackup.startsWith(ENCRYPTION_PREFIX) ||
		typeof backup.pubKey !== "string"
	) {
		throw new Error("Invalid 1Sat wallet backup");
	}
	if (
		backup.format !== undefined &&
		(backup.format !== "1sat-web-wallet" ||
			backup.version !== 1 ||
			backup.cipher !== "AES-256-GCM")
	) {
		throw new Error("Unsupported 1Sat wallet backup version");
	}
	if (backup.network !== undefined && backup.network !== "test") {
		throw new Error("Invalid 1Sat wallet backup");
	}
	return backup as unknown as EncryptedBackupJson;
}

/** Replace one storage value and restore the previous value if verification fails. */
export function commitWalletBackup(
	storage: WalletStorage,
	value: string,
): void {
	const previous = storage.getItem(WALLET_STORAGE_KEY);
	try {
		storage.setItem(WALLET_STORAGE_KEY, value);
		if (storage.getItem(WALLET_STORAGE_KEY) !== value) {
			throw new Error("Wallet backup was not persisted");
		}
	} catch (error) {
		if (previous === null) storage.removeItem(WALLET_STORAGE_KEY);
		else storage.setItem(WALLET_STORAGE_KEY, previous);
		throw error;
	}
}

function walletPayload(keys: Keys, network: Chain) {
	return {
		mnemonic: keys.mnemonic,
		payPk: keys.payPk,
		ordPk: keys.ordPk,
		payDerivationPath: keys.changeAddressPath,
		ordDerivationPath: keys.ordAddressPath,
		identityPk: keys.identityPk,
		identityDerivationPath: keys.identityAddressPath,
		...networkField(network),
	};
}

/** The value this tab is announcing while its synthetic storage event runs. */
let ownWrite: string | null = null;

function notifyWalletStorage(value: string): void {
	if (typeof window === "undefined") return;
	ownWrite = value;
	try {
		window.dispatchEvent(
			new StorageEvent("storage", {
				key: WALLET_STORAGE_KEY,
				newValue: value,
			}),
		);
	} catch (error) {
		console.error("[wallet-storage] storage notification failed", error);
		reportDiagnostic({
			category: "action",
			code: "action.failed",
			operation: "wallet.storage.notify",
			recoverable: true,
		});
	} finally {
		ownWrite = null;
	}
	// Covers browsers that refuse a constructed StorageEvent; a no-op when
	// the event already moved the chain.
	refreshWalletChain();
}

/**
 * For a storage listener that holds unlocked keys: whether a wallet is stored
 * after a change made elsewhere (another tab, clear(), or a delete); undefined
 * when the event does not touch the wallet or is this tab's own save, whose
 * keys and key cache are already current. A real cross-tab event never runs
 * inside this tab's synchronous dispatch, so it is never mistaken for one.
 */
export function walletChangedElsewhere(
	event: { key: string | null; newValue: string | null },
	storage: Pick<Storage, "getItem"> | undefined,
): boolean | undefined {
	if (
		ownWrite !== null &&
		event.key === WALLET_STORAGE_KEY &&
		event.newValue === ownWrite
	) {
		return undefined;
	}
	return walletStoredAfter(event, storage);
}

async function encryptAuthenticated(
	data: Uint8Array,
	key: Uint8Array,
): Promise<Uint8Array> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		key as BufferSource,
		"AES-GCM",
		false,
		["encrypt"],
	);
	const encrypted = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv: iv as BufferSource },
			cryptoKey,
			data as BufferSource,
		),
	);
	const combined = new Uint8Array(iv.length + encrypted.length);
	combined.set(iv);
	combined.set(encrypted, iv.length);
	return combined;
}

async function decryptAuthenticated(
	data: Uint8Array,
	key: Uint8Array,
): Promise<Uint8Array> {
	if (data.length <= 28) throw new Error("Invalid encrypted wallet data");
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		key as BufferSource,
		"AES-GCM",
		false,
		["decrypt"],
	);
	return new Uint8Array(
		await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: data.slice(0, 12) as BufferSource },
			cryptoKey,
			data.slice(12) as BufferSource,
		),
	);
}

export async function createEncryptedWalletBackup(
	walletData: Keys,
	passphrase: string,
	network: Chain = "main",
): Promise<EncryptedBackupJson> {
	if (!walletData.payPk) throw new Error("No payment key found");
	const pubKey = PrivateKey.fromWif(walletData.payPk).toPublicKey().toString();
	const encryptionKey = await generateEncryptionKeyFromPassphrase(
		passphrase,
		pubKey,
	);
	if (!encryptionKey) throw new Error("Could not derive encryption key");

	const combined = await encryptAuthenticated(
		new TextEncoder().encode(
			JSON.stringify(walletPayload(walletData, network)),
		),
		encryptionKey,
	);

	return {
		format: "1sat-web-wallet",
		version: 1,
		cipher: "AES-256-GCM",
		encryptedBackup: ENCRYPTION_PREFIX + Utils.toBase64(Array.from(combined)),
		pubKey,
		...networkField(network),
	};
}

export interface DecryptedWallet {
	keys: Keys;
	/** Testnet if either the envelope or the encrypted payload says so. */
	network: Chain;
}

export async function decryptEncryptedWalletBackup(
	backup: EncryptedBackupJson,
	passphrase: string,
): Promise<DecryptedWallet> {
	const parsed = parseEncryptedBackupJson(backup);
	const encryptionKey = await generateEncryptionKeyFromPassphrase(
		passphrase,
		parsed.pubKey,
	);
	if (!encryptionKey) throw new Error("Could not derive decryption key");
	const rawData = parsed.encryptedBackup.slice(ENCRYPTION_PREFIX.length);
	const encryptedBytes = new Uint8Array(Utils.toArray(rawData, "base64"));
	const decryptedBytes =
		parsed.format === "1sat-web-wallet"
			? await decryptAuthenticated(encryptedBytes, encryptionKey)
			: await decryptData(encryptedBytes, encryptionKey);
	const json = JSON.parse(new TextDecoder().decode(decryptedBytes)) as Record<
		string,
		unknown
	>;
	if (typeof json.payPk !== "string" || typeof json.ordPk !== "string") {
		throw new Error("Backup is missing wallet keys");
	}
	PrivateKey.fromWif(json.payPk);
	PrivateKey.fromWif(json.ordPk);
	if (json.identityPk !== undefined) {
		if (typeof json.identityPk !== "string") {
			throw new Error("Backup has an invalid identity key");
		}
		PrivateKey.fromWif(json.identityPk);
	}
	if (json.network !== undefined && json.network !== "test") {
		throw new Error("Backup has an invalid network");
	}
	const keys: Keys = {
		payPk: json.payPk,
		ordPk: json.ordPk,
		mnemonic: typeof json.mnemonic === "string" ? json.mnemonic : undefined,
		changeAddressPath:
			typeof json.payDerivationPath === "string"
				? json.payDerivationPath
				: undefined,
		ordAddressPath:
			typeof json.ordDerivationPath === "string"
				? json.ordDerivationPath
				: undefined,
		identityPk:
			typeof json.identityPk === "string" ? json.identityPk : undefined,
		identityAddressPath:
			typeof json.identityDerivationPath === "string"
				? json.identityDerivationPath
				: undefined,
	};
	return {
		keys,
		network:
			parsed.network === "test" || json.network === "test" ? "test" : "main",
	};
}

/**
 * Re-encrypt wallet data using the cached encryption key.
 * Used during migration to update stored keys without requiring the passphrase again.
 */
export const reencryptWallet = async (
	keys: Keys,
	storage: WalletStorage | undefined = getLocalStorage(),
): Promise<boolean> => {
	if (!storage || !cachedEncryptionKey || !cachedPubKeySalt || !cachedNetwork)
		return false;

	try {
		if (!storage.getItem(WALLET_STORAGE_KEY)) {
			throw new Error("No stored wallet to re-encrypt");
		}
		// The network is fixed at create/import; re-encryption never changes it.
		// It comes from the unlock or save, never from the envelope, whose
		// field could have been stripped.
		const network = cachedNetwork;
		const dataStr = JSON.stringify(walletPayload(keys, network));
		const dataBytes = new TextEncoder().encode(dataStr);

		const combined = await encryptAuthenticated(dataBytes, cachedEncryptionKey);

		const encryptedBackup =
			ENCRYPTION_PREFIX + Utils.toBase64(Array.from(combined));

		const backupJson: EncryptedBackupJson = {
			format: "1sat-web-wallet",
			version: 1,
			cipher: "AES-256-GCM",
			encryptedBackup,
			pubKey: cachedPubKeySalt,
			...networkField(network),
		};

		const serialized = JSON.stringify(backupJson);
		commitWalletBackup(storage, serialized);
		notifyWalletStorage(serialized);
		return true;
	} catch {
		reportDiagnostic({
			category: "action",
			code: "action.failed",
			operation: "wallet.storage.migrate",
			recoverable: true,
		});
		return false;
	}
};

// --- Encryption and Decryption Handlers ---
export const saveEncryptedWallet = async (
	walletData: Keys,
	passphrase: string,
	network: Chain,
): Promise<boolean> => {
	const storage = getLocalStorage();
	if (!storage) return false;

	try {
		const backupJson = await createEncryptedWalletBackup(
			walletData,
			passphrase,
			network,
		);
		const serialized = JSON.stringify(backupJson);
		commitWalletBackup(storage, serialized);

		// Cache only after durable storage succeeds.
		cachedEncryptionKey =
			(await generateEncryptionKeyFromPassphrase(
				passphrase,
				backupJson.pubKey,
			)) ?? null;
		cachedPubKeySalt = backupJson.pubKey;
		cachedNetwork = network;
		notifyWalletStorage(serialized);
		return true;
	} catch {
		reportDiagnostic({
			category: "action",
			code: "action.failed",
			operation: "wallet.storage.save",
			recoverable: true,
		});
		return false;
	}
};

/**
 * Decrypts the stored wallet. Null for a wrong password or unreadable data;
 * throws WalletSaveError when it decrypted but a needed repair write failed.
 */
export const loadEncryptedWallet = async (
	passphrase: string,
	storage: WalletStorage | undefined = getLocalStorage(),
): Promise<Keys | null> => {
	if (!storage) return null;

	try {
		const storedItem = storage.getItem(WALLET_STORAGE_KEY);
		if (!storedItem) return null;

		const encryptedKeys = parseEncryptedBackupJson(JSON.parse(storedItem));
		const { keys, network } = await decryptEncryptedWalletBackup(
			encryptedKeys,
			passphrase,
		);

		// A testnet account whose envelope lost its field (the payload is
		// authenticated, the envelope is not): restore it before the keys are
		// handed out, so the wallet never initializes on mainnet. No synthetic
		// storage event here: it would lock the wallet being unlocked. If the
		// write fails the wallet stays locked, with its own message.
		if (network === "test" && encryptedKeys.network !== "test") {
			try {
				commitWalletBackup(
					storage,
					JSON.stringify({ ...encryptedKeys, network: "test" }),
				);
			} catch (error) {
				throw new WalletSaveError(error);
			}
			refreshWalletChain();
		}

		cachedEncryptionKey =
			(await generateEncryptionKeyFromPassphrase(
				passphrase,
				encryptedKeys.pubKey,
			)) ?? null;
		cachedPubKeySalt = encryptedKeys.pubKey;
		cachedNetwork = network;
		return keys;
	} catch (error) {
		const repair = error instanceof WalletSaveError;
		reportDiagnostic({
			category: "action",
			code: "action.failed",
			operation: repair ? "wallet.storage.repair" : "wallet.storage.unlock",
			recoverable: true,
		});
		if (repair) throw error;
		return null;
	}
};

// --- Settings Storage Hook ---
export const useSettingsStorage = <T>(
	storageKey: string,
	initialValue: T,
): [T, (value: T) => void] => {
	const [storedValue, setStoredValue] = useState<T>(() => {
		if (typeof window === "undefined") return initialValue;
		try {
			const item = window.localStorage.getItem(storageKey);
			return item ? JSON.parse(item) : initialValue;
		} catch {
			reportDiagnostic({
				category: "action",
				code: "action.failed",
				operation: "wallet.settings.read",
				recoverable: true,
			});
			return initialValue;
		}
	});

	const setValue = useCallback(
		(value: T) => {
			try {
				setStoredValue(value);
				if (typeof window !== "undefined") {
					const newValue = JSON.stringify(value);
					window.localStorage.setItem(storageKey, newValue);
					window.dispatchEvent(
						new StorageEvent("storage", { key: storageKey, newValue }),
					);
				}
			} catch {
				reportDiagnostic({
					category: "action",
					code: "action.failed",
					operation: "wallet.settings.write",
					recoverable: true,
				});
			}
		},
		[storageKey],
	);

	useEffect(() => {
		const handleStorageChange = (event: StorageEvent) => {
			if (event.key === storageKey && event.newValue) {
				setStoredValue(JSON.parse(event.newValue));
			}
		};
		window.addEventListener("storage", handleStorageChange);
		return () => window.removeEventListener("storage", handleStorageChange);
	}, [storageKey]);

	return [storedValue, setValue];
};
