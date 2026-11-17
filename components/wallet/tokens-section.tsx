"use client";

import { Coins } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { isOneColorAvailable } from "@/lib/chain-endpoints";
import { useWalletChain } from "@/lib/hooks/use-wallet-chain";
import { type CreatedToken, tokenDetailHref } from "@/lib/wallet/create-token";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import { CreateToken } from "./create-token";
import OneColorGrid from "./one-color-grid";
import TokenGrid from "./token-grid";
import { TokenRowsSkeleton } from "./token-row";

/**
 * The Tokens section: Create token, then one quiet group per standard the
 * chain has. BSV-21 on every chain; 1Color only where it has an overlay
 * (testnet), so mainnet shows no 1Color anywhere. Rows open each token's
 * page, where Receive, Send and Mint live.
 */
export function TokensSection() {
	const chain = useWalletChain();
	const { isInitialized, isInitializing } = useWalletToolbox();
	const [created, setCreated] = useState<CreatedToken | null>(null);
	const oneColor = isOneColorAvailable(chain);

	return (
		<div className="flex flex-col gap-6">
			<div className="flex items-center justify-between gap-4">
				<p className="min-w-0 text-muted-foreground text-sm">
					{oneColor ? "Your BSV-21 and 1Color tokens." : "Your BSV-21 tokens."}
				</p>
				<CreateToken onCreated={setCreated} />
			</div>
			{created ? (
				<Notice role="status" title="Token created">
					<span className="wrap-anywhere">{created.message}</span>
					{created.id ? (
						<>
							{" "}
							<Link
								className="text-foreground underline underline-offset-4"
								href={tokenDetailHref(created.standard, created.id)}
							>
								Open the token
							</Link>
						</>
					) : null}
				</Notice>
			) : null}
			{isInitializing ? (
				<TokenRowsSkeleton />
			) : !isInitialized ? (
				<EmptyState
					description="Or connect a wallet."
					icon={Coins}
					title="Unlock your wallet to see your tokens"
				/>
			) : (
				<>
					<TokenGrid />
					{oneColor ? <OneColorGrid /> : null}
				</>
			)}
		</div>
	);
}
