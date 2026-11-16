"use client";

import { useQuery } from "@tanstack/react-query";
import {
	isOneColorQueryEnabled,
	oneColorBalancesQueryKey,
} from "@/hooks/use-one-color-balances";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import { listPendingOneColorSends } from "@/lib/wallet/one-color-actions";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

/**
 * The asset's sends waiting to be claimed, read through the permissions
 * manager (`colorContext`) so the descriptions it encrypted read back. The
 * key sits under the holdings key, so refreshing the holdings refreshes it.
 */
export function useOneColorPending(assetId: string) {
	const { colorContext, chain, connectionMode, identityKey, wallet } =
		useWalletToolbox();
	return useQuery({
		queryKey: [
			...oneColorBalancesQueryKey(chain, identityKey),
			"pending",
			assetId,
		],
		enabled:
			colorContext !== null &&
			isOneColorQueryEnabled({
				chain,
				connectionMode,
				hasWallet: wallet !== null,
				identityKey,
			}),
		queryFn: async () => {
			if (!colorContext)
				throw new Error("No color context to read 1Color sends from.");
			try {
				return await listPendingOneColorSends(colorContext.wallet, assetId);
			} catch (error) {
				console.error(`[1color] pending sends of ${assetId} failed:`, error);
				reportDiagnostic({
					category: "provider",
					code: "provider.failed",
					operation: "wallet.1color.pending",
					recoverable: true,
					context: { retryable: true },
				});
				throw error;
			}
		},
	});
}
