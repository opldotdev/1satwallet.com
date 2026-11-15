"use client";

import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Chain } from "@/lib/chain-endpoints";
import { readWalletChain, subscribeWalletChain } from "@/lib/wallet-chain";
import { WalletToolboxProvider } from "@/providers/wallet-toolbox-provider";

/**
 * Runs the wallet on the saved network. A switch clears every cached query and
 * remounts the wallet provider, which tears the old wallet down and opens the
 * new chain's storage, so nothing from one chain shows on the other.
 */
export function WalletChainProvider({ children }: { children: ReactNode }) {
	const queryClient = useQueryClient();
	const [chain, setChain] = useState<Chain>(() => readWalletChain());
	const chainRef = useRef(chain);

	useEffect(
		() =>
			subscribeWalletChain(() => {
				const next = readWalletChain();
				if (next === chainRef.current) return;
				chainRef.current = next;
				queryClient.clear();
				setChain(next);
			}),
		[queryClient],
	);

	return (
		<WalletToolboxProvider key={chain} chain={chain}>
			{children}
		</WalletToolboxProvider>
	);
}
