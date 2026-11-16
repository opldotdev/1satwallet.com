"use client";

import { Coins, KeyRound, Loader2 } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { type ReactNode, useSyncExternalStore } from "react";
import { useOneColorBalances } from "@/hooks/use-one-color-balances";
import { isOneColorAvailable } from "@/lib/chain-endpoints";
import { describeAssetSurface } from "@/lib/wallet/asset-query-state";
import { formatBsv21Amount } from "@/lib/wallet/bsv21-actions";
import { type OneColorBalance, oneColorTicker } from "@/lib/wallet/one-color";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

/** The token's deploy icon, else a coin, in a rounded tile of `size` pixels. */
export function OneColorIcon({
	icon,
	size,
}: {
	icon: string | undefined;
	size: 48 | 80;
}) {
	return (
		<div
			className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted ${size === 80 ? "size-20 border" : "size-12"}`}
		>
			{icon ? (
				<Image
					src={icon}
					alt=""
					fill
					sizes={`${size}px`}
					className="object-cover"
					unoptimized
				/>
			) : (
				<Coins
					className={`text-muted-foreground ${size === 80 ? "size-10" : "size-6"}`}
				/>
			)}
		</div>
	);
}

/** The "1Color" chip and, for an authority holder, the "Authority" chip. */
export function OneColorChips({ authorities }: { authorities: number }) {
	return (
		<>
			<span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs uppercase">
				1Color
			</span>
			{authorities > 0 ? (
				<span
					className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-primary text-xs"
					title={`${authorities} authority output${authorities === 1 ? "" : "s"}: this wallet can mint`}
				>
					<KeyRound className="size-3" />
					Authority
				</span>
			) : null}
		</>
	);
}

function OneColorCard({ token }: { token: OneColorBalance }) {
	const ticker = oneColorTicker(token);
	return (
		<Link
			href={`/wallet/1color/${token.assetId}`}
			className="flex items-center gap-4 rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
		>
			<OneColorIcon icon={token.icon} size={48} />
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-semibold text-foreground">{ticker}</span>
					<OneColorChips authorities={token.authorities} />
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
		</Link>
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

	if (query.isPending)
		return <OneColorLoading label="Loading 1Color tokens…" />;

	if (query.isError) {
		return (
			<OneColorNotice>
				<p>
					{describeAssetSurface(
						{ kind: "error", message: query.error.message },
						"token",
					)}
				</p>
			</OneColorNotice>
		);
	}

	const tokens = query.data;
	if (tokens.length === 0) {
		return (
			<OneColorNotice>
				<p>No 1Color tokens found in your wallet.</p>
			</OneColorNotice>
		);
	}

	return (
		<div className="space-y-4">
			<h2 className="text-lg font-medium">
				{tokens.length} 1Color token{tokens.length === 1 ? "" : "s"}
			</h2>
			<div className="space-y-2">
				{tokens.map((token) => (
					<OneColorCard key={token.assetId} token={token} />
				))}
			</div>
		</div>
	);
}

/** 1Color (BRC-162) tokens held by the wallet. Read-only. */
export default function OneColorGrid() {
	return (
		<OneColorGate>
			<OneColorList />
		</OneColorGate>
	);
}
