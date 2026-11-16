"use client";

import { useQuery } from "@tanstack/react-query";
import { Label } from "@/components/ui/label";
import { endpointsOf } from "@/lib/chain-endpoints";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import {
	advertisedMessageboxHosts,
	messageboxHostName,
} from "@/lib/wallet/peerpay-inbox";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

/**
 * Where this account receives PeerPay: the MessageBox host the overlay lists
 * as advertised for it, and the boxes its inbox is read from. Read-only, as
 * iOS `MessageBoxReceivingSection` shows the status.
 */
export function MessageboxReceiving() {
	const { wallet, chain, identityKey } = useWalletToolbox();
	const { messagebox, extraMessageboxes } = endpointsOf(chain);
	const ownHost = messageboxHostName(messagebox);
	const advertised = useQuery({
		queryKey: ["messagebox-advertisement", chain, identityKey],
		enabled: !!wallet && !!identityKey,
		staleTime: 5 * 60_000,
		queryFn: async () => {
			if (!wallet || !identityKey) return [];
			try {
				return await advertisedMessageboxHosts(wallet, chain, identityKey);
			} catch (error) {
				reportDiagnostic({
					category: "action",
					code: "action.failed",
					operation: "wallet.peerpay.advertisement",
					recoverable: true,
				});
				console.error("[peerpay] advertisement lookup failed", {
					chain,
					error,
				});
				throw error;
			}
		},
	});

	let status: React.ReactNode;
	if (advertised.isPending) {
		status = "Checking the advertisement…";
	} else if (advertised.isError) {
		status = "The advertisement couldn't be checked.";
	} else if (advertised.data.includes(ownHost)) {
		status = (
			<>
				Advertised at <code className="font-mono">{ownHost}</code>.
			</>
		);
	} else if (advertised.data.length > 0) {
		status = (
			<>
				Advertised at{" "}
				<code className="font-mono">{advertised.data.join(", ")}</code>, not at
				this wallet's box <code className="font-mono">{ownHost}</code>.
			</>
		);
	} else {
		status = (
			<>
				No advertisement found. This wallet's box is{" "}
				<code className="font-mono">{ownHost}</code>.
			</>
		);
	}

	return (
		<div className="flex flex-col space-y-1">
			<Label className="text-base">Receiving</Label>
			<span className="text-sm text-muted-foreground">
				{status} Other wallets look up the advertisement to deliver PeerPay
				payments.
			</span>
			{extraMessageboxes.length > 0 && (
				<span className="text-sm text-muted-foreground">
					Also read from{" "}
					<code className="font-mono">
						{extraMessageboxes.map(messageboxHostName).join(", ")}
					</code>
					.
				</span>
			)}
		</div>
	);
}
