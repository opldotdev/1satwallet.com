"use client";

import { Coins, KeyRound, Loader2, RefreshCw } from "lucide-react";
import { type ReactNode, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useOneColorBalances } from "@/hooks/use-one-color-balances";
import { isOneColorAvailable } from "@/lib/chain-endpoints";
import { describeAssetSurface } from "@/lib/wallet/asset-query-state";
import { formatBsv21Amount } from "@/lib/wallet/bsv21-actions";
import { tokenDetailHref } from "@/lib/wallet/create-token";
import { oneColorTicker } from "@/lib/wallet/one-color";
import { shortOutpoint } from "@/lib/wallet/wallet-output-utils";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import { OneColorReceiveDialog } from "./one-color-receive";
import {
	TokenGroup,
	TokenList,
	TokenRow,
	TokenRowsSkeleton,
} from "./token-row";

/** Marks a token this wallet can mint: it holds a mint authority. */
export function OneColorAuthorityChip({
	authorities,
}: {
	authorities: number;
}) {
	if (authorities <= 0) return null;
	return (
		<span
			className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-primary text-xs"
			title={`${authorities} mint authorit${authorities === 1 ? "y" : "ies"}: this wallet can mint`}
		>
			<KeyRound aria-hidden="true" className="size-3" />
			Can mint
		</span>
	);
}

export function OneColorNotice({ children }: { children: ReactNode }) {
	return (
		<div
			className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground"
			role="status"
		>
			<Coins className="mb-4 size-12 opacity-50" />
			{children}
		</div>
	);
}

export function OneColorLoading({ label }: { label: string }) {
	return (
		<div className="flex items-center justify-center py-12">
			<Loader2 className="size-8 animate-spin text-muted-foreground" />
			<span className="ml-3 text-muted-foreground">{label}</span>
		</div>
	);
}

const noSubscription = () => () => {};

/**
 * Whether the built-in wallet's 1Color tokens can be read here, before any
 * read: "unavailable" on a chain without 1Color, "locked" with no wallet
 * open, "external" while an external wallet (which keeps its own tokens) is
 * connected.
 */
export type OneColorAccess =
	| "loading"
	| "unavailable"
	| "locked"
	| "external"
	| "ready";

export function useOneColorAccess(): OneColorAccess {
	const { chain, connectionMode, isInitialized, isInitializing } =
		useWalletToolbox();
	// Pages prerender as mainnet, so nothing chain-specific is decided until
	// the client knows the active account's network: a testnet account is
	// never sent away from a 1Color page, and hydration never mismatches.
	const mounted = useSyncExternalStore(
		noSubscription,
		() => true,
		() => false,
	);
	if (!mounted) return "loading";
	if (!isOneColorAvailable(chain)) return "unavailable";
	if (isInitializing) return "loading";
	if (!isInitialized) return "locked";
	if (connectionMode === "external") return "external";
	return "ready";
}

/** An external wallet keeps its own 1Color tokens; this site reads its own. */
export function OneColorExternalWallet() {
	return (
		<EmptyState
			description="This site shows 1Color tokens held in its own wallet only."
			icon={Coins}
			title={describeAssetSurface(
				{ kind: "unsupported", capability: "provider-managed" },
				"token",
			)}
		/>
	);
}

function OneColorList() {
	const query = useOneColorBalances();

	if (query.isPending) return <TokenRowsSkeleton />;
	if (query.isError) {
		return (
			<EmptyState
				icon={Coins}
				title={describeAssetSurface(
					{ kind: "error", message: query.error.message },
					"token",
				)}
				action={
					<Button onClick={() => void query.refetch()} variant="outline">
						<RefreshCw data-icon="inline-start" /> Retry
					</Button>
				}
			/>
		);
	}
	if (query.data.length === 0) {
		return (
			<EmptyState
				description="Tokens sent to your handle, or created here, show up here."
				icon={Coins}
				title="No 1Color tokens yet"
			/>
		);
	}
	return (
		<TokenList>
			{query.data.map((token) => (
				<TokenRow
					amount={formatBsv21Amount(token.available, token.dec)}
					badge={<OneColorAuthorityChip authorities={token.authorities} />}
					caption={
						token.pending > 0n
							? `${formatBsv21Amount(token.pending, token.dec)} pending`
							: shortOutpoint(token.assetId)
					}
					href={tokenDetailHref("1color", token.assetId)}
					icon={token.icon}
					key={token.assetId}
					ticker={oneColorTicker(token)}
				/>
			))}
		</TokenList>
	);
}

/**
 * The 1Color group of the Tokens section (testnet only): BRC-162 holdings
 * of the built-in wallet. The heading stays while the wallet loads, is
 * locked or is external; a chain without 1Color renders nothing at all.
 */
export default function OneColorGrid() {
	const access = useOneColorAccess();
	if (access === "unavailable") return null;

	let content: ReactNode;
	if (access === "loading") {
		content = <TokenRowsSkeleton />;
	} else if (access === "locked") {
		content = (
			<EmptyState
				icon={Coins}
				title="Unlock your wallet to see your 1Color tokens"
			/>
		);
	} else if (access === "external") {
		content = <OneColorExternalWallet />;
	} else {
		content = <OneColorList />;
	}

	return (
		<TokenGroup
			action={access === "ready" ? <OneColorReceiveDialog /> : undefined}
			id="tokens-1color"
			title="1Color"
		>
			{content}
		</TokenGroup>
	);
}
