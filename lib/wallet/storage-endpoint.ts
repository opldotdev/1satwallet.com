import { type Chain, endpointsOf } from "@/lib/chain-endpoints";

/**
 * The remote storage the built-in wallet uses as its active store. The local
 * IndexedDB store is registered beside it as a backup.
 *
 * A wallet has one active storage, and the same keys must never point at two
 * storages, or they diverge. So every chain uses its hosted 1Sat storage, the
 * same one Yours and the iOS app use. NEXT_PUBLIC_WALLET_STORAGE_URL is a
 * mainnet deploy setting and never applies to testnet.
 */
export function walletStorageUrl(chain: Chain): string {
	if (chain === "main" && process.env.NEXT_PUBLIC_WALLET_STORAGE_URL) {
		return process.env.NEXT_PUBLIC_WALLET_STORAGE_URL;
	}
	return endpointsOf(chain).storage;
}

/** The host to show for the active store. */
export function walletStorageHost(chain: Chain): string {
	const url = walletStorageUrl(chain);
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}
