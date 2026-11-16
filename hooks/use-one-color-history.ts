"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import {
	isOneColorQueryEnabled,
	oneColorBalancesQueryKey,
} from "@/hooks/use-one-color-balances";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import {
	fetchOneColorHistory,
	ONE_COLOR_HISTORY_PAGE,
	type OneColorHistoryEntry,
	type OneColorHistoryPage,
} from "@/lib/wallet/one-color";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

/**
 * One asset's history, a page at a time, read through the permissions
 * manager (`colorContext`) so the descriptions it encrypted read back. The
 * key sits under the holdings key, so refreshing the holdings refreshes it.
 */
export function useOneColorHistory(assetId: string) {
	const { colorContext, chain, connectionMode, identityKey, wallet } =
		useWalletToolbox();
	return useInfiniteQuery({
		queryKey: [
			...oneColorBalancesQueryKey(chain, identityKey),
			"history",
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
		initialPageParam: 0,
		queryFn: async ({ pageParam }) => {
			if (!colorContext)
				throw new Error("No color context to read 1Color history from.");
			try {
				return await fetchOneColorHistory(colorContext.wallet, assetId, {
					offset: pageParam,
				});
			} catch (error) {
				console.error(`[1color] history of ${assetId} failed:`, error);
				reportDiagnostic({
					category: "provider",
					code: "provider.failed",
					operation: "wallet.1color.history",
					recoverable: true,
					context: { retryable: true },
				});
				throw error;
			}
		},
		getNextPageParam: (lastPage, _pages, offset) =>
			lastPage.entries.length === ONE_COLOR_HISTORY_PAGE
				? offset + ONE_COLOR_HISTORY_PAGE
				: undefined,
	});
}

/**
 * The loaded pages as one list, each transaction once: pages are read at
 * offsets, so an action that arrives between two reads shifts the next page
 * and would repeat a row. `truncated` is the last page's: the scan stopped at
 * its cap with older actions unread.
 */
export const flattenOneColorHistory = (
	pages: OneColorHistoryPage[],
): { entries: OneColorHistoryEntry[]; truncated: boolean } => {
	const seen = new Set<string>();
	const entries: OneColorHistoryEntry[] = [];
	for (const page of pages) {
		for (const entry of page.entries) {
			if (seen.has(entry.action.txid)) continue;
			seen.add(entry.action.txid);
			entries.push(entry);
		}
	}
	return { entries, truncated: pages.at(-1)?.truncated ?? false };
};
