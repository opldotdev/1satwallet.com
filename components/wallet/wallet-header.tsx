"use client";

import { LockKeyhole, LogOut } from "lucide-react";
import Link from "next/link";
import { PageHeader, PageTitle } from "@/components/page-layout";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/providers/wallet-provider";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

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
		<PageHeader className="grid min-h-24 grid-cols-1 gap-4 md:min-h-20 md:grid-cols-[1fr_auto] md:gap-6">
			<div>
				<PageTitle>Wallet</PageTitle>
				<p className="mt-1 text-sm text-muted-foreground">
					Your money, assets, and connection at a glance.
				</p>
			</div>
			<div className="flex h-9 items-center gap-3 text-xs md:justify-end">
				<span className="flex min-w-32 items-center gap-2" role="status">
					<span
						className={`size-1.5 shrink-0 rounded-full ${isInitialized ? "bg-emerald-500" : "bg-muted-foreground"}`}
					/>
					{label}
				</span>
				{isInitialized && connectionMode === "external" ? (
					<Button
						className="min-w-28"
						size="sm"
						variant="ghost"
						onClick={() => void disconnectExternalWallet()}
					>
						<LogOut />
						Disconnect
					</Button>
				) : isInitialized && connectionMode === "built-in" ? (
					<Button
						className="min-w-28"
						size="sm"
						variant="ghost"
						onClick={lockWallet}
					>
						<LockKeyhole />
						Lock
					</Button>
				) : isInitializing ? (
					<Button className="min-w-28" size="sm" variant="ghost" disabled>
						Connecting…
					</Button>
				) : (
					<Button className="min-w-28" size="sm" variant="ghost" asChild>
						<Link href="/wallet">Connect</Link>
					</Button>
				)}
			</div>
		</PageHeader>
	);
}
