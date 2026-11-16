import type { Chain } from "@/lib/chain-endpoints";
import type { WalletConnectionOption } from "@/lib/wallet/connection-options";
import {
	EXTERNAL_NETWORK_KEY,
	refreshWalletChain,
	WALLET_CONNECTION_MODE_KEY,
} from "@/lib/wallet-chain";

export { WALLET_CONNECTION_MODE_KEY };
export const CONNECTION_OPTION_KEY = "1sat-wallet-connection-option";

type ConnectionStorage = Pick<Storage, "setItem" | "removeItem">;

interface ConnectionDeps {
	storage?: ConnectionStorage;
	refresh?: () => void;
}

/*
 * Every write of the persisted connection goes through these helpers, so the
 * active chain (which follows a persisted external session) is recomputed.
 */

function deps({ storage, refresh }: ConnectionDeps = {}) {
	return {
		storage: storage ?? window.localStorage,
		refresh: refresh ?? refreshWalletChain,
	};
}

export function persistBuiltInConnection(options?: ConnectionDeps): void {
	const { storage, refresh } = deps(options);
	storage.setItem(WALLET_CONNECTION_MODE_KEY, "built-in");
	storage.removeItem(CONNECTION_OPTION_KEY);
	storage.removeItem(EXTERNAL_NETWORK_KEY);
	refresh();
}

/** Records an external session and the network it reported. */
export function persistExternalConnection(
	network: Chain,
	option?: WalletConnectionOption,
	options?: ConnectionDeps,
): void {
	const { storage, refresh } = deps(options);
	storage.setItem(WALLET_CONNECTION_MODE_KEY, "external");
	if (option) storage.setItem(CONNECTION_OPTION_KEY, option);
	storage.setItem(EXTERNAL_NETWORK_KEY, network);
	refresh();
}

export function clearConnection(options?: ConnectionDeps): void {
	const { storage, refresh } = deps(options);
	storage.removeItem(WALLET_CONNECTION_MODE_KEY);
	storage.removeItem(CONNECTION_OPTION_KEY);
	storage.removeItem(EXTERNAL_NETWORK_KEY);
	refresh();
}
