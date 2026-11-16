"use client";

import { createContext } from "@1sat/actions";
import { useQuery } from "@tanstack/react-query";
import { type Chain, isOneColorAvailable } from "@/lib/chain-endpoints";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import { getOneColorBalances } from "@/lib/wallet/one-color";
import {
	useWalletToolbox,
	type WalletConnectionMode,
} from "@/providers/wallet-toolbox-provider";

export const oneColorBalancesQueryKey = (
	chain: Chain,
	identityKey: string | null,
) => ["one-color", chain, identityKey] as const;

/**
 * 1Color holdings are read only on a chain with a color overlay, and only
 * from the website's own wallet: an external wallet keeps its own token
 * baskets.
 */
export const isOneColorQueryEnabled = (state: {
	chain: Chain;
	connectionMode: WalletConnectionMode;
	hasWallet: boolean;
	identityKey: string | null;
}): boolean =>
	isOneColorAvailable(state.chain) &&
	state.connectionMode === "built-in" &&
	state.hasWallet &&
	state.identityKey !== null;

/** The built-in wallet's 1Color balances, read from its raw wallet. */
export function useOneColorBalances() {
	const { wallet, services, chain, connectionMode, identityKey } =
		useWalletToolbox();
	return useQuery({
		queryKey: oneColorBalancesQueryKey(chain, identityKey),
		enabled: isOneColorQueryEnabled({
			chain,
			connectionMode,
			hasWallet: wallet !== null,
			identityKey,
		}),
		queryFn: async () => {
			if (!wallet) throw new Error("No wallet to read 1Color holdings from.");
			try {
				return await getOneColorBalances(
					createContext(wallet, { services: services ?? undefined, chain }),
				);
			} catch (error) {
				console.error("[1color] holdings read failed:", error);
				reportDiagnostic({
					category: "provider",
					code: "provider.failed",
					operation: "wallet.1color.holdings",
					recoverable: true,
					context: { retryable: true },
				});
				throw error;
			}
		},
	});
}
