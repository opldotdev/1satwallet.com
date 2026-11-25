import { type Chain, endpointsOf } from "@/lib/chain-endpoints";
import {
	loadStorageChoice,
	normalizeStorageUrl,
} from "@/lib/wallet/storage-choice";

/**
 * The hosted 1Sat storage, the same one Yours and the iOS app use by
 * default. NEXT_PUBLIC_WALLET_STORAGE_URL is a mainnet deploy setting and
 * never applies to testnet.
 */
export function defaultWalletStorageUrl(chain: Chain): string {
	const override = process.env.NEXT_PUBLIC_WALLET_STORAGE_URL;
	if (chain === "main" && override) {
		// Normalized like a chosen address, so the two compare equal (a
		// trailing slash would otherwise read as a different store).
		try {
			return normalizeStorageUrl(override);
		} catch {
			return override;
		}
	}
	return endpointsOf(chain).storage;
}

/**
 * The remote storage the built-in wallet opens as its active store: the
 * provider chosen for this account on this browser, or the hosted default.
 * The local IndexedDB store is registered beside it as a backup.
 *
 * A wallet has one active store at a time. The store's user record names it,
 * every other store is a backup synced from it, and a move made on another
 * device is followed when the wallet opens (see `getStorageStatus`).
 */
export function walletStorageUrl(chain: Chain, identityKey?: string): string {
	const chosen = identityKey ? loadStorageChoice(chain, identityKey) : null;
	return chosen ?? defaultWalletStorageUrl(chain);
}

/** The host of a storage address, for display. */
export function storageHostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/** The host to show for the active store. */
export function walletStorageHost(chain: Chain, identityKey?: string): string {
	return storageHostOf(walletStorageUrl(chain, identityKey));
}
