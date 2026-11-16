"use client";

import { Coins, KeyRound, Loader2 } from "lucide-react";
import Image from "next/image";
import { type ReactNode, useSyncExternalStore } from "react";
import { useOneColorBalances } from "@/hooks/use-one-color-balances";
import { isOneColorAvailable } from "@/lib/chain-endpoints";
import { describeAssetSurface } from "@/lib/wallet/asset-query-state";
import { formatBsv21Amount } from "@/lib/wallet/bsv21-actions";
import { type OneColorBalance, oneColorTicker } from "@/lib/wallet/one-color";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import { OneColorReceiveDialog } from "./one-color-receive";

function OneColorCard({ token }: { token: OneColorBalance }) {
	const ticker = oneColorTicker(token);
	return (
		<div className="flex items-center gap-4 rounded-lg border border-border bg-card p-4">
			<div className="relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
				{token.icon ? (
					<Image
						src={token.icon}
						alt=""
						fill
						sizes="48px"
						className="object-cover"
						unoptimized
					/>
				) : (
					<Coins className="size-6 text-muted-foreground" />
				)}
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-semibold text-foreground">{ticker}</span>
					<span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs uppercase">
						1Color
					</span>
					{token.authorities > 0 ? (
						<span
							className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-primary text-xs"
							title={`${token.authorities} authority output${token.authorities === 1 ? "" : "s"}: this wallet can mint`}
						>
							<KeyRound className="size-3" />
							Authority
						</span>
					) : null}
				</div>
				<div className="truncate text-muted-foreground text-sm">
					{formatBsv21Amount(token.available, token.dec)} available
					{token.pending > 0n
						? ` · ${formatBsv21Amount(token.pending, token.dec)} pending`
						: ""}
				</div>
			</div>
			<div
				className="hidden max-w-24 truncate font-mono text-muted-foreground text-xs sm:block"
				title={token.assetId}
			>
				{token.assetId.slice(0, 8)}…
			</div>
		</div>
	);
}

function Notice({ children }: { children: ReactNode }) {
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

function Loading({ label }: { label: string }) {
	return (
		<div className="flex items-center justify-center py-12">
			<Loader2 className="size-8 animate-spin text-muted-foreground" />
			<span className="ml-3 text-muted-foreground">{label}</span>
		</div>
	);
}

const noSubscription = () => () => {};

/** 1Color (BRC-162) tokens held by the wallet. Read-only. */
export default function OneColorGrid() {
	const { chain, connectionMode, isInitialized, isInitializing } =
		useWalletToolbox();
	const query = useOneColorBalances();
	// The page prerenders as mainnet, so nothing chain-specific renders until
	// the client knows the active account's network: a testnet account never
	// flashes the "testnet only" notice and hydration never mismatches.
	const mounted = useSyncExternalStore(
		noSubscription,
		() => true,
		() => false,
	);

	if (!mounted) return <Loading label="Loading wallet…" />;

	if (!isOneColorAvailable(chain)) {
		return (
			<Notice>
				<p>
					1Color tokens are on testnet only, and this wallet is a mainnet
					account.
				</p>
			</Notice>
		);
	}

	if (isInitializing) return <Loading label="Loading wallet…" />;

	if (!isInitialized) {
		return (
			<Notice>
				<p>Please unlock or connect a wallet to view your 1Color tokens.</p>
			</Notice>
		);
	}

	if (connectionMode === "external") {
		return (
			<Notice>
				<p>
					{describeAssetSurface(
						{ kind: "unsupported", capability: "provider-managed" },
						"token",
					)}
				</p>
			</Notice>
		);
	}

	let content: ReactNode;
	let heading = "1Color tokens";
	if (query.isPending) {
		content = <Loading label="Loading 1Color tokens…" />;
	} else if (query.isError) {
		content = (
			<Notice>
				<p>
					{describeAssetSurface(
						{ kind: "error", message: query.error.message },
						"token",
					)}
				</p>
			</Notice>
		);
	} else if (query.data.length === 0) {
		content = (
			<Notice>
				<p>No 1Color tokens found in your wallet.</p>
			</Notice>
		);
	} else {
		const tokens = query.data;
		heading = `${tokens.length} 1Color token${tokens.length === 1 ? "" : "s"}`;
		content = (
			<div className="space-y-2">
				{tokens.map((token) => (
					<OneColorCard key={token.assetId} token={token} />
				))}
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between gap-2">
				<h2 className="text-lg font-medium">{heading}</h2>
				<OneColorReceiveDialog />
			</div>
			{content}
		</div>
	);
}
