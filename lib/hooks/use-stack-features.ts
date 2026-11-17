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

/** Whether the stack serves BSV-21, and whether it is still being asked. */
export function useBsv21Availability() {
	const features = useStackFeatures();
	return {
		available: features.data?.features.bsv21 === true,
		checking: features.isLoading,
	};
}
