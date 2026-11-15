"use client";

import type { ReactNode } from "react";
import { NotOnTestnet } from "@/components/not-on-testnet";
import { useWalletChain } from "@/lib/hooks/use-wallet-chain";

/**
 * Renders mainnet-only UI on mainnet, and a short notice (or nothing) on
 * testnet. A first load on testnet never reaches the page: the proxy serves
 * the notice from the network cookie. This covers in-app navigation and a
 * tab that just switched, where the client already knows the network.
 */
export function MainnetOnly({
	children,
	fallback = <NotOnTestnet />,
}: {
	children: ReactNode;
	fallback?: ReactNode;
}) {
	return useWalletChain() === "main" ? children : fallback;
}
