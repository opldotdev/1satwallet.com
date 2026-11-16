"use client";

import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Chain } from "@/lib/chain-endpoints";
import {
	readWalletChain,
	subscribeWalletChain,
	takeLegacyTestnetNotice,
} from "@/lib/wallet-chain";
import { WalletToolboxProvider } from "@/providers/wallet-toolbox-provider";

/**
 * Runs the wallet on the active account's network: the connected external
 * wallet's, else the built-in account's, else mainnet. When the account
 * changes to another network, every cached query is cleared and the wallet
 * provider remounts, which tears the old wallet down and opens the new
 * chain's storage, so nothing from one chain shows on the other.
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

	useEffect(() => {
		if (!takeLegacyTestnetNotice()) return;
		toast("This wallet is on Mainnet", {
			description:
				"The network is now part of each wallet, not a setting. To use testnet, import a wallet and choose Testnet.",
			duration: Number.POSITIVE_INFINITY,
			closeButton: true,
		});
	}, []);

	return (
		<WalletToolboxProvider key={chain} chain={chain}>
			{children}
		</WalletToolboxProvider>
	);
}
