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
 * What every 1Color page shows before it can read the built-in wallet: the
 * mainnet notice, the unlock prompt, the external-wallet notice. Renders
 * `children` once the built-in wallet is ready on a chain with 1Color.
 */
export function OneColorGate({ children }: { children: ReactNode }) {
	const { chain, connectionMode, isInitialized, isInitializing } =
		useWalletToolbox();
	// The page prerenders as mainnet, so nothing chain-specific renders until
	// the client knows the active account's network: a testnet account never
	// flashes the "testnet only" notice and hydration never mismatches.
	const mounted = useSyncExternalStore(
		noSubscription,
		() => true,
		() => false,
	);

	if (!mounted) return <OneColorLoading label="Loading wallet…" />;

	if (!isOneColorAvailable(chain)) {
		return (
			<OneColorNotice>
				<p>
					1Color tokens are on testnet only, and this wallet is a mainnet
					account.
				</p>
			</OneColorNotice>
		);
	}

	if (isInitializing) return <OneColorLoading label="Loading wallet…" />;

	if (!isInitialized) {
		return (
			<OneColorNotice>
				<p>Please unlock or connect a wallet to view your 1Color tokens.</p>
			</OneColorNotice>
		);
	}

	if (connectionMode === "external") {
		return (
			<OneColorNotice>
				<p>
					{describeAssetSurface(
						{ kind: "unsupported", capability: "provider-managed" },
						"token",
					)}
				</p>
			</OneColorNotice>
		);
	}

	return children;
}

function OneColorList() {
	const query = useOneColorBalances();

	let content: ReactNode;
	if (query.isPending) {
		content = <TokenRowsSkeleton />;
	} else if (query.isError) {
		content = (
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
	} else if (query.data.length === 0) {
		content = (
			<EmptyState
				description="Tokens sent to your handle, or created here, show up here."
				icon={Coins}
				title="No 1Color tokens yet"
			/>
		);
	} else {
		content = (
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

	return (
		<TokenGroup
			action={<OneColorReceiveDialog />}
			id="tokens-1color"
			title="1Color"
		>
			{content}
		</TokenGroup>
	);
}

/** The 1Color group of the Tokens section (testnet only): BRC-162 holdings. */
export default function OneColorGrid() {
	return (
		<OneColorGate>
			<OneColorList />
		</OneColorGate>
	);
}
