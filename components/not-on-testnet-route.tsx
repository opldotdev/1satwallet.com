"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { NotOnTestnet } from "@/components/not-on-testnet";
import { readWalletChain, subscribeWalletChain } from "@/lib/wallet-chain";

/**
 * The page the proxy serves in place of a mainnet-only page on testnet. The
 * router caches it under the real URL, so once the active account is on
 * mainnet (after sign-out, a wallet replace or an external disconnect, here or
 * in another tab) refresh to get the real page.
 */
export function NotOnTestnetRoute() {
	const router = useRouter();

	useEffect(() => {
		const refreshOnMainnet = () => {
			if (readWalletChain() === "main") router.refresh();
		};
		refreshOnMainnet();
		return subscribeWalletChain(refreshOnMainnet);
	}, [router]);

	return <NotOnTestnet />;
}
