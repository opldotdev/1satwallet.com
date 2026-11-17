"use client";

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
import { describeAssetSurface } from "@/lib/wallet/asset-query-state";
import {
	formatBsv21Amount,
	normalizeBsv21TokenId,
} from "@/lib/wallet/bsv21-actions";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import { Bsv21AuthorityManager } from "./bsv21-authority-manager";
import { TokenDetailLayout } from "./token-detail-layout";
import {
	Bsv21SendDialog,
	Bsv21UnavailableNotice,
	bsv21Icon,
	bsv21Ticker,
} from "./token-grid";

/** Opens the mint authority manager with this token's ID filled in. */
function MintButton({
	tokenId,
	onDone,
}: {
	tokenId: string;
	onDone: (message: string) => void;
}) {
	const { oneSatContext } = useWalletToolbox();
	const { available } = useBsv21Availability();
	return (
		<Bsv21AuthorityManager
			onDone={onDone}
			tokenId={tokenId}
			trigger={
				<Button disabled={!(oneSatContext && available)} variant="outline">
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
		return (
			<EmptyState
				icon={Coins}
				title={describeAssetSurface(bsv21State, "token")}
			/>
		);
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
					action={<MintButton onDone={onDone} tokenId={tokenId} />}
					description="A new token shows here once the BSV-21 overlay indexes it. If you hold its mint authority, you can mint it."
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
					<MintButton onDone={onDone} tokenId={tokenId} />
				</>
			}
			balance={formatBsv21Amount(token.all.confirmed, token.dec)}
			balanceCaption={
				token.all.pending > 0n
					? `${formatBsv21Amount(token.all.pending, token.dec)} pending`
					: "Available"
			}
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
					{statusLine}
				</>
			}
			ticker={ticker}
		/>
	);
}
