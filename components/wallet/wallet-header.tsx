"use client";

import { ArrowLeft, LockKeyhole, LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PageHeader, PageTitle } from "@/components/page-layout";
import { Button } from "@/components/ui/button";
import { TestnetBadge } from "@/components/wallet/testnet-badge";
import { useSound } from "@/hooks/use-sound";
import { unavailableRouteRedirect } from "@/lib/chain-surfaces";
import { useMounted } from "@/lib/hooks/use-mounted";
import { useWalletChain } from "@/lib/hooks/use-wallet-chain";
import { walletSectionFor } from "@/lib/wallet-sections";
import { useWallet } from "@/providers/wallet-provider";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

/**
 * The headline names the section you are in (the tab's own label), or the
 * sub-page with a back arrow to where it came from. The right side is the
 * connection: a status dot and Lock or Disconnect.
 */
export function WalletHeader() {
	const { lockWallet } = useWallet();
	const {
		connectionMode,
		connectionStatus,
		isInitialized,
		isInitializing,
		providerType,
		disconnectExternalWallet,
	} = useWalletToolbox();
	const { play } = useSound();
	const chain = useWalletChain();
	const pathname = usePathname();
	const section = walletSectionFor(pathname, chain);
	// A page only some chains have (1Color's) can't be named before the client
	// knows the account's chain: the server always renders mainnet, which has
	// no such page. Show no headline until then rather than the wrong one.
	const mounted = useMounted();
	const unnamed =
		!mounted && unavailableRouteRedirect("main", pathname) !== null;
	const label = isInitializing
		? "Connecting…"
		: connectionStatus === "locked"
			? "Wallet locked"
			: !isInitialized
				? "Not connected"
				: connectionMode === "built-in"
					? "Embedded wallet"
					: providerType === "desktop"
						? "Desktop wallet"
						: providerType === "injected"
							? "Injected wallet"
							: providerType === "embedded"
								? "Mobile wallet"
								: "Wallet connected";
	return (
		<PageHeader className="min-h-11 items-start">
			<div className="flex min-w-0 items-start gap-1">
				{section.parentHref && !unnamed ? (
					<Button
						asChild
						className="-ml-3 shrink-0 md:-ml-2"
						size="icon"
						variant="ghost"
					>
						<Link
							aria-label={`Back to ${section.parentTitle}`}
							href={section.parentHref}
							onClick={() => play("click")}
						>
							<ArrowLeft />
						</Link>
					</Button>
				) : null}
				<div className="flex min-w-0 flex-col gap-1 max-md:min-h-11 max-md:justify-center">
					<div className="flex min-w-0 items-center gap-2">
						<PageTitle className="truncate">
							{unnamed ? null : section.title}
						</PageTitle>
						{chain === "test" ? (
							<span className="flex shrink-0">
								<TestnetBadge />
							</span>
						) : null}
					</div>
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-1 md:gap-2">
				<span
					className="flex size-11 items-center justify-center md:size-9"
					role="status"
					title={label}
				>
					<span
						aria-hidden="true"
						className={`size-2 rounded-full ${isInitialized ? "bg-success" : "bg-muted-foreground"}`}
					/>
					<span className="sr-only">{label}</span>
				</span>
				{isInitialized && connectionMode === "external" ? (
					<Button
						className="max-md:min-w-11"
						size="sm"
						variant="ghost"
						onClick={() => void disconnectExternalWallet()}
					>
						<LogOut />
						<span className="max-md:sr-only">Disconnect</span>
					</Button>
				) : isInitialized && connectionMode === "built-in" ? (
					<Button
						className="max-md:min-w-11"
						size="sm"
						variant="ghost"
						onClick={lockWallet}
					>
						<LockKeyhole />
						<span className="max-md:sr-only">Lock</span>
					</Button>
				) : isInitializing ? (
					<Button size="sm" variant="ghost" disabled>
						Connecting…
					</Button>
				) : (
					<Button size="sm" variant="ghost" asChild>
						<Link href="/wallet">Connect</Link>
					</Button>
				)}
			</div>
		</PageHeader>
	);
}
