type Chain = "main" | "test";

/**
 * The remote storage the built-in wallet uses as its active store. The local
 * IndexedDB store is registered beside it as a backup.
 *
 * wallet.1sat.app is the hosted BRC-100 storage server (the old
 * api.1sat.app/1sat/wallet URL 404s, and wallet-browser >=0.0.7x verifies the
 * storage connection eagerly at init). Testnet has no remote here, so its
 * active store is local.
 */
export function walletStorageUrl(chain: Chain): string | undefined {
	return (
		process.env.NEXT_PUBLIC_WALLET_STORAGE_URL ||
		(chain === "main" ? "https://wallet.1sat.app" : undefined)
	);
}

/** The host to show for the active store, or undefined when it is local. */
export function walletStorageHost(chain: Chain): string | undefined {
	const url = walletStorageUrl(chain);
	if (!url) return undefined;
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}
