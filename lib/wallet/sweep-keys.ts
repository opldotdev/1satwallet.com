import { PrivateKey } from "@bsv/sdk";
import {
	type DecryptedBackup,
	decryptBackup,
	isWifBackup,
} from "bitcoin-backup";
import {
	deriveIdentityKey,
	derivePathFromMnemonic,
	isValidMnemonic,
	RELAYX_SWEEP_PATH,
} from "@/lib/keys";
import {
	type DetectedWalletBackup,
	decryptWalletBackup,
	detectWalletBackup,
} from "@/lib/wallet-backup";

/**
 * Keys a sweep scans and signs with. They live only in memory for the
 * sweep: nothing here stores them.
 */
export interface ScanKey {
	/** What the key is, for the address list and messages; never the key */
	label: string;
	wif: string;
	/** P2PKH address the scan looks up and the sweep resolves own: events to */
	address: string;
}

export type SweepInput =
	| { kind: "keys"; source: string; keys: ScanKey[] }
	| { kind: "needs-password"; source: string; backup: DetectedWalletBackup };

const PHRASE_WORD_COUNTS = new Set([12, 15, 18, 21, 24]);

export const RELAYX_PATH_LABEL = `Recovery phrase at ${RELAYX_SWEEP_PATH}`;

function readWif(wif: string): PrivateKey | null {
	try {
		return PrivateKey.fromWif(wif);
	} catch {
		return null;
	}
}

/** Each key with its address; a key whose address is already listed is dropped. */
export function scanKeyList(
	entries: readonly { label: string; wif: string }[],
): ScanKey[] {
	const seen = new Set<string>();
	const keys: ScanKey[] = [];
	for (const { label, wif } of entries) {
		const key = readWif(wif);
		if (!key) throw new Error(`The ${label.toLowerCase()} is not a valid WIF`);
		const address = key.toPublicKey().toAddress();
		if (seen.has(address)) continue;
		seen.add(address);
		keys.push({ label, wif, address });
	}
	return keys;
}

/**
 * One WIF, as @1sat/sweep-ui reads it: the key itself, plus the identity key
 * a 1Sat wallet would derive with it as both pay and ord key.
 */
export function keysFromWif(wif: string): ScanKey[] {
	if (!readWif(wif)) throw new Error("The key is not a valid WIF");
	return scanKeyList([
		{ label: "Private key", wif },
		{ label: "Derived identity key", wif: deriveIdentityKey(wif, wif).toWif() },
	]);
}

/** The single key a phrase holds at the RelayX path (m/44'/236'/0'/0/0). */
export function keysFromPhrase(phrase: string): ScanKey[] {
	const normalized = normalizePhrase(phrase);
	if (!isRecoveryPhrase(normalized)) {
		throw new Error("The recovery phrase is not valid");
	}
	return scanKeyList([
		{
			label: RELAYX_PATH_LABEL,
			wif: derivePathFromMnemonic(normalized, RELAYX_SWEEP_PATH).toWif(),
		},
	]);
}

/**
 * A pay/ord key set (1Sat, Yours): both keys, the identity key the backup
 * names, the identity key derived from pay and ord, and the RelayX path of
 * its phrase when it has one.
 */
export function keysFromKeySet(set: {
	payPk: string;
	ordPk: string;
	identityPk?: string;
	mnemonic?: string;
}): ScanKey[] {
	if (!readWif(set.payPk) || !readWif(set.ordPk)) {
		throw new Error("The backup's payment or ordinal key is not valid");
	}
	const entries = [
		{ label: "Payment key", wif: set.payPk },
		{ label: "Ordinals key", wif: set.ordPk },
	];
	if (set.identityPk) {
		entries.push({ label: "Identity key", wif: set.identityPk });
	}
	entries.push({
		label: "Derived identity key",
		wif: deriveIdentityKey(set.payPk, set.ordPk).toWif(),
	});
	const keys = scanKeyList(entries);
	if (set.mnemonic && isRecoveryPhrase(normalizePhrase(set.mnemonic))) {
		const [relayx] = keysFromPhrase(set.mnemonic);
		if (!keys.some((k) => k.address === relayx.address)) keys.push(relayx);
	}
	return keys;
}

const stringField = (value: Record<string, unknown>, field: string) =>
	typeof value[field] === "string" ? (value[field] as string) : undefined;

/**
 * Keys from a decrypted bitcoin-backup payload or a plain JSON key file: a
 * WifBackup ({ wif }), or any payPk/ordPk set, with or without an identity key.
 */
export function keysFromBackupPayload(payload: unknown): ScanKey[] {
	if (payload === null || typeof payload !== "object") {
		throw new Error("This backup holds no private key");
	}
	const value = payload as Record<string, unknown>;
	const wif = stringField(value, "wif");
	if (wif && isWifBackup(value as unknown as DecryptedBackup)) {
		return keysFromWif(wif);
	}
	const payPk = stringField(value, "payPk");
	const ordPk = stringField(value, "ordPk");
	if (payPk && ordPk) {
		return keysFromKeySet({
			payPk,
			ordPk,
			identityPk: stringField(value, "identityPk"),
			mnemonic: stringField(value, "mnemonic"),
		});
	}
	throw new Error("This backup holds no WIF, payment or ordinal key");
}

function normalizePhrase(phrase: string): string {
	return phrase.trim().toLowerCase().split(/\s+/).join(" ");
}

function isRecoveryPhrase(normalized: string): boolean {
	return (
		PHRASE_WORD_COUNTS.has(normalized.split(" ").length) &&
		isValidMnemonic(normalized)
	);
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Unlock a backup that needs a password (or none), giving its keys. */
export async function unlockSweepBackup(
	backup: DetectedWalletBackup,
	password: string,
): Promise<ScanKey[]> {
	if (backup.kind === "bitcoin-backup") {
		return keysFromBackupPayload(
			await decryptBackup(backup.encrypted, password),
		);
	}
	const { keys } = await decryptWalletBackup(backup, password);
	if (!keys.payPk || !keys.ordPk) {
		throw new Error("This backup holds no payment or ordinal key");
	}
	return keysFromKeySet({
		payPk: keys.payPk,
		ordPk: keys.ordPk,
		identityPk: keys.identityPk,
		mnemonic: keys.mnemonic,
	});
}

/**
 * A backup file: a plain WifBackup JSON, or any backup the import page reads
 * (bitcoin-backup .bep, 1Sat web, Yours). Encrypted ones ask for a password.
 */
export async function readSweepFile(
	bytes: Uint8Array,
	fileName: string,
): Promise<SweepInput> {
	const json = parseJson(new TextDecoder().decode(bytes).trim());
	if (json && typeof json === "object" && "wif" in json) {
		return {
			kind: "keys",
			source: "WIF backup",
			keys: keysFromBackupPayload(json),
		};
	}
	const backup = detectWalletBackup(bytes, fileName);
	if (backup.requiresPassword) {
		return { kind: "needs-password", source: backup.label, backup };
	}
	return {
		kind: "keys",
		source: backup.label,
		keys: await unlockSweepBackup(backup, ""),
	};
}

/**
 * Pasted text: a WIF, a recovery phrase (swept at the RelayX path), a JSON
 * key backup, or an encrypted bitcoin-backup string.
 */
export async function readSweepText(text: string): Promise<SweepInput> {
	const trimmed = text.trim();
	if (!trimmed) throw new Error("Paste a WIF, a backup or a recovery phrase");
	if (!/\s/.test(trimmed) && readWif(trimmed)) {
		return { kind: "keys", source: "WIF", keys: keysFromWif(trimmed) };
	}
	const phrase = normalizePhrase(trimmed);
	if (/^[a-z]+( [a-z]+){11,}$/.test(phrase)) {
		if (!isRecoveryPhrase(phrase)) {
			throw new Error("That recovery phrase is not valid");
		}
		return {
			kind: "keys",
			source: "Recovery phrase",
			keys: keysFromPhrase(phrase),
		};
	}
	try {
		return await readSweepFile(new TextEncoder().encode(trimmed), "pasted.bep");
	} catch (error) {
		if (
			error instanceof Error &&
			error.message === "Unsupported wallet backup file"
		) {
			throw new Error("That is not a WIF, a key backup or a recovery phrase");
		}
		throw error;
	}
}
