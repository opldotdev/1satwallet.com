"use client";

import { useQuery } from "@tanstack/react-query";
import { Coins, Sparkles } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { DetailRow } from "@/components/ui/detail-list";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { isRouteAvailableOn } from "@/lib/chain-surfaces";
import { useBsv21Availability } from "@/lib/hooks/use-stack-features";
import { useWalletChain } from "@/lib/hooks/use-wallet-chain";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import {
	formatBsv21Amount,
	normalizeBsv21TokenId,
} from "@/lib/wallet/bsv21-actions";
import { holdsBsv21MintAuthority } from "@/lib/wallet/bsv21-authority";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import { Bsv21AuthorityManager } from "./bsv21-authority-manager";
import { TokenDetailLayout } from "./token-detail-layout";
import {
	Bsv21SendDialog,
	Bsv21UnavailableNotice,
	Bsv21Unreadable,
	bsv21Icon,
	bsv21Spendable,
	bsv21Ticker,
} from "./token-grid";

const NO_AUTHORITY =
	"Minting needs this token's mint authority, and this wallet doesn't hold it.";

/**
 * Whether this wallet holds `tokenId`'s mint authority: true or false once
 * read, null while reading or when the read failed (Mint then stays on and
 * the mint itself says why it can't). Kept under the balance's key, so every
 * balance refresh, a mint's included, reads it again.
 */
function useMintAuthority(tokenId: string): boolean | null {
	const { bsv21State, chain, identityKey, oneSatContext } = useWalletToolbox();
	// Read only from a wallet whose BSV-21 outputs this site already reads.
	const readable = bsv21State.kind === "ready" || bsv21State.kind === "empty";
	const query = useQuery({
		queryKey: [
			"wallet-balance",
			chain,
			identityKey,
			"bsv21-mint-authority",
			tokenId,
		],
		enabled: readable && oneSatContext !== null,
		retry: false,
		queryFn: async () => {
			if (!oneSatContext)
				throw new Error("No wallet to read authorities from.");
			try {
				return await holdsBsv21MintAuthority(oneSatContext, tokenId);
			} catch (error) {
				console.error(`[bsv21] mint authority of ${tokenId} not read:`, error);
				reportDiagnostic({
					category: "provider",
					code: "provider.failed",
					operation: "wallet.bsv21.mint-authority",
					recoverable: true,
					context: { retryable: true },
				});
				throw error;
			}
		},
	});
	return query.isSuccess ? query.data : null;
}

/**
 * Opens the mint authority manager with this token's ID filled in. Off when
 * the wallet is known to hold no authority for it.
 */
function MintButton({
	tokenId,
	authority,
	onDone,
}: {
	tokenId: string;
	authority: boolean | null;
	onDone: (message: string) => void;
}) {
	const { oneSatContext } = useWalletToolbox();
	const { available } = useBsv21Availability();
	return (
		<Bsv21AuthorityManager
			onDone={onDone}
			tokenId={tokenId}
			trigger={
				<Button
					disabled={!(oneSatContext && available) || authority === false}
					title={authority === false ? NO_AUTHORITY : undefined}
					variant="outline"
				>
					<Sparkles data-icon="inline-start" /> Mint
				</Button>
			}
		/>
	);
}

function DetailSkeleton() {
	return (
		<div aria-live="polite" className="flex flex-col gap-4" role="status">
			<span className="sr-only">Loading token…</span>
			<div className="flex items-center gap-4">
				<Skeleton className="size-16 rounded-lg" />
				<div className="flex flex-1 flex-col gap-2">
					<Skeleton className="h-5 w-24" />
					<Skeleton className="h-8 w-40" />
				</div>
			</div>
			<Skeleton className="h-11 w-full" />
		</div>
	);
}

/**
 * One BSV-21 token in this wallet: balance, Send and Mint, then its facts,
 * with a link to its market on mainnet. The wallet header is the page's h1
 * and back arrow to Tokens.
 */
export default function Bsv21Detail({ tokenId }: { tokenId: string }) {
	const chain = useWalletChain();
	const {
		bsv21State,
		bsv21Tokens,
		isBalanceLoading,
		isInitialized,
		isInitializing,
	} = useWalletToolbox();
	const [status, setStatus] = useState<string | null>(null);
	const onDone = useCallback((message: string) => setStatus(message), []);
	const authority = useMintAuthority(tokenId);
	const noAuthority =
		authority === false ? (
			<p className="text-muted-foreground text-sm">{NO_AUTHORITY}</p>
		) : null;
	const marketHref = `/market/bsv21/${tokenId}`;
	const statusLine = status ? (
		<p className="text-primary text-sm wrap-anywhere" role="status">
			{status}
		</p>
	) : null;

	if (isInitializing || (isInitialized && isBalanceLoading)) {
		return <DetailSkeleton />;
	}
	if (!isInitialized) {
		return (
			<EmptyState
				description="Or connect a wallet."
				icon={Coins}
				title="Unlock your wallet to see this token"
			/>
		);
	}
	if (bsv21State.kind !== "ready" && bsv21State.kind !== "empty") {
		return <Bsv21Unreadable state={bsv21State} />;
	}

	const token = bsv21Tokens.find(
		(item) => normalizeBsv21TokenId(item.id) === tokenId,
	);
	if (!token) {
		// A token just created with no supply, or not yet indexed, is held by
		// nobody yet; its mint authority may still be in this wallet.
		return (
			<div className="flex flex-col gap-4">
				<EmptyState
					action={
						authority === false ? undefined : (
							<MintButton
								authority={authority}
								onDone={onDone}
								tokenId={tokenId}
							/>
						)
					}
					description={
						authority === false
							? "A new token shows here once the BSV-21 overlay indexes it. This wallet doesn't hold its mint authority either."
							: "A new token shows here once the BSV-21 overlay indexes it. If you hold its mint authority, you can mint it."
					}
					icon={Coins}
					title="This wallet holds none of this token"
				/>
				{statusLine}
			</div>
		);
	}

	const ticker = bsv21Ticker(token);
	return (
		<TokenDetailLayout
			actions={
				<>
					<Bsv21SendDialog onSent={onDone} token={token} />
					<MintButton authority={authority} onDone={onDone} tokenId={tokenId} />
				</>
			}
			balance={formatBsv21Amount(bsv21Spendable(token), token.dec)}
			balanceCaption="Available"
			details={
				<>
					<DetailRow label="Decimals">{token.dec}</DetailRow>
					{isRouteAvailableOn(chain, marketHref) ? (
						<DetailRow label="Market" mono={false}>
							<Link
								className="underline underline-offset-4 hover:text-foreground"
								href={marketHref}
							>
								View market
							</Link>
						</DetailRow>
					) : null}
				</>
			}
			icon={bsv21Icon(token, chain)}
			id={token.id}
			idLabel="Token ID"
			status={
				<>
					<Bsv21UnavailableNotice />
					{noAuthority}
					{statusLine}
				</>
			}
			ticker={ticker}
		/>
	);
}
