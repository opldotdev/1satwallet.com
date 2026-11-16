"use client";

import { useSyncExternalStore } from "react";
import type { Chain } from "@/lib/chain-endpoints";
import { readWalletChain, subscribeWalletChain } from "@/lib/wallet-chain";

const serverChain = (): Chain => "main";

/**
 * The active account's network, for rendering. Mainnet during server render
 * and hydration, then the account's network, so markup never mismatches.
 */
export function useWalletChain(): Chain {
	return useSyncExternalStore(
		subscribeWalletChain,
		readWalletChain,
		serverChain,
	);
}
