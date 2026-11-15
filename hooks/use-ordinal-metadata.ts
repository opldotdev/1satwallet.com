"use client";

import type { WalletOutput } from "@1sat/actions";
import { useQuery } from "@tanstack/react-query";
import { getDisplayOutpoint } from "@/lib/wallet/wallet-output-utils";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

export function useOrdinalMetadata(
	ordinals: WalletOutput[],
	identityKey: string | null,
	enabled: boolean,
) {
	// The wallet's own services, so metadata comes from the wallet's chain.
	const { chain, services } = useWalletToolbox();
	const metadataRequests = ordinals.map(
		(ordinal) => `${getDisplayOutpoint(ordinal)}:-2`,
	);
	const metadataQuery = useQuery({
		queryKey: ["ordinal-metadata", chain, identityKey, metadataRequests],
		queryFn: () => {
			if (!services) throw new Error("Wallet services are not ready");
			return services.ordfs.bulkMetadata(metadataRequests);
		},
		enabled: enabled && !!services && metadataRequests.length > 0,
		staleTime: 5 * 60_000,
	});

	return { metadataRequests, metadataQuery };
}
