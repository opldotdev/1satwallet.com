"use client";

import { useQuery } from "@tanstack/react-query";
import type { Chain } from "@/lib/chain-endpoints";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import { listHandles } from "@/lib/wallet/handles";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

export const walletHandlesQueryKey = (
	chain: Chain,
	identityKey: string | null,
) => ["wallet-handles", chain, identityKey] as const;

/** The BRC-169 handles the website's own wallet holds. */
export function useWalletHandles() {
	const { wallet, chain, connectionMode, identityKey } = useWalletToolbox();
	return useQuery({
		queryKey: walletHandlesQueryKey(chain, identityKey),
		enabled:
			connectionMode === "built-in" && wallet !== null && identityKey !== null,
		queryFn: async () => {
			if (!wallet) throw new Error("No wallet to read handles from.");
			try {
				return await listHandles(wallet);
			} catch (error) {
				reportDiagnostic({
					category: "action",
					code: "action.failed",
					operation: "wallet.handles.list",
					recoverable: true,
					context: { retryable: true },
				});
				console.error("[handles] listing handle certificates failed", {
					chain,
					error,
				});
				throw error;
			}
		},
	});
}
