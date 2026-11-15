"use client";

import { useQuery } from "@tanstack/react-query";
import { useWalletChain } from "@/lib/hooks/use-wallet-chain";
import { fetchStackCapabilities, stackUrlForChain } from "@/lib/stack";
import { createStackFeatureRegistry } from "@/lib/stack-features";

/** Capabilities of the stack for the wallet's network. */
export function useStackFeatures() {
	const stackUrl = stackUrlForChain(useWalletChain());
	return useQuery({
		queryKey: ["stack-feature-registry", stackUrl],
		queryFn: async () =>
			createStackFeatureRegistry(await fetchStackCapabilities(stackUrl)),
		staleTime: 60_000,
		refetchInterval: 60_000,
	});
}
