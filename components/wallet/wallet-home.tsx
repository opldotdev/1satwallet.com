"use client";

import { Loader2, LockKeyhole, RefreshCw } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { WalletConnectCarousel } from "@/components/wallet/wallet-connect-carousel";
import { WalletHomeActions } from "@/components/wallet/wallet-home-actions";
import { WalletHomeStatus } from "@/components/wallet/wallet-home-status";
import { PRIVACY_MODE_KEY } from "@/lib/constants";
import { useSettingsStorage } from "@/lib/wallet-storage";
import { useWallet } from "@/providers/wallet-provider";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import styles from "./wallet-home.module.css";

function LoadingHome({ message }: { message: string }) {
	return (
		<div
			className="flex min-h-80 items-center justify-center gap-3 text-sm text-muted-foreground"
			role="status"
		>
			<Loader2 className="size-4 motion-safe:animate-spin" />
			{message}
		</div>
	);
}

function FailedWalletHome({ message }: { message: string }) {
	const { lockWallet } = useWallet();
	return (
		<section className="space-y-4 py-16">
			<h2 className="font-mono text-xl">Wallet could not be opened</h2>
			<p className="break-words text-sm text-destructive" role="alert">
				{message}
			</p>
			<Button onClick={lockWallet} variant="ghost">
				Lock and retry
			</Button>
		</section>
	);
}

function LockedWalletHome({ external }: { external: boolean }) {
	const { disconnectExternalWallet } = useWalletToolbox();
	return (
		<section className="flex min-h-80 flex-col items-center justify-center gap-4 text-center">
			<LockKeyhole className="size-7 text-primary" />
			<h2 className="font-mono text-xl">Wallet locked</h2>
			<p className="text-sm text-muted-foreground">
				{external
					? "Unlock your connected wallet, then reconnect."
					: "Use the unlock prompt to continue."}
			</p>
			{external && (
				<Button onClick={() => void disconnectExternalWallet()} variant="ghost">
					Choose another wallet
				</Button>
			)}
		</section>
	);
}

function ConnectedWalletHome() {
	const {
		balance,
		balanceError,
		connectionMode,
		exchangeRate,
		isBalanceLoading,
		legacyBalance,
		refreshBalance,
	} = useWalletToolbox();
	const [privacyMode] = useSettingsStorage<boolean>(PRIVACY_MODE_KEY, false);
	const balanceSupported =
		connectionMode === "built-in" || isBalanceLoading || balance !== null;
	const totalBsv =
		balanceSupported && balance ? balance.total / 100_000_000 : null;
	const totalUsd =
		totalBsv !== null && exchangeRate !== null ? totalBsv * exchangeRate : null;

	return (
		<div className={styles.home}>
			{balanceSupported && balanceError && (
				<div
					className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/50 bg-destructive/10 p-4"
					role="alert"
				>
					<div>
						<p className="font-medium text-destructive">
							Wallet data could not be refreshed
						</p>
						<p className="mt-1 break-all text-muted-foreground text-sm">
							{balanceError.message}
						</p>
					</div>
					<Button onClick={refreshBalance} size="sm" variant="outline">
						<RefreshCw data-icon="inline-start" /> Retry
					</Button>
				</div>
			)}

			<section className={styles.hero} aria-labelledby="wallet-balance-heading">
				<div className={styles.balanceContent}>
					<div className={styles.balanceStack}>
						<div>
							<p className={styles.eyebrow} id="wallet-balance-heading">
								Spendable balance
							</p>
							{!balanceSupported ? (
								<div className="mt-3">
									<p className="text-2xl font-semibold text-muted-foreground">
										Provider-managed
									</p>
									<p className="mt-1 text-muted-foreground text-sm">
										This provider does not expose a certified spendable-balance
										summary.
									</p>
								</div>
							) : isBalanceLoading || (!balance && !balanceError) ? (
								<div className="mt-3 space-y-2" role="status">
									<Skeleton className="h-10 w-60" />
									<Skeleton className="h-4 w-28" />
									<span className="sr-only">Loading wallet balance</span>
								</div>
							) : balanceError ? (
								<p className="mt-3 text-2xl font-semibold text-muted-foreground">
									Unavailable
								</p>
							) : (
								<>
									<p className={styles.amount}>
										{privacyMode ? "••••••••" : totalBsv?.toFixed(8)}
										{!privacyMode && <span className={styles.unit}>BSV</span>}
									</p>
									{!privacyMode && totalUsd !== null && (
										<p className="mt-1 text-muted-foreground text-sm">
											${totalUsd.toFixed(2)} USD
										</p>
									)}
								</>
							)}
						</div>
						<WalletHomeActions />
					</div>
				</div>
				<div className={styles.radar} aria-hidden="true">
					<Image
						src="/images/wallet/radar.png"
						alt=""
						width={1254}
						height={1254}
						sizes="(max-width: 767px) 180px, 380px"
					/>
				</div>
			</section>

			{connectionMode === "built-in" && legacyBalance > 0 && (
				<div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
					<div>
						<p className="font-medium">Legacy balance found</p>
						<p className="text-muted-foreground text-sm">
							{privacyMode
								? "Funds are held on legacy addresses."
								: `${(legacyBalance / 100_000_000).toFixed(8)} BSV is held on legacy addresses.`}
						</p>
					</div>
					<Button asChild size="sm">
						<Link href="/wallet/migrate">Review migration</Link>
					</Button>
				</div>
			)}
			<WalletHomeStatus />
		</div>
	);
}

export function WalletHome() {
	const { hasWallet, isWalletInitialized, isWalletLocked } = useWallet();
	const {
		connectionMode,
		connectionStatus,
		identityKey,
		initError,
		isInitialized,
		isInitializing,
	} = useWalletToolbox();

	if (!isWalletInitialized) return <LoadingHome message="Loading wallet…" />;
	if (isInitialized && identityKey) {
		return <ConnectedWalletHome key={identityKey} />;
	}
	if (connectionStatus === "locked" || (hasWallet && isWalletLocked)) {
		return <LockedWalletHome external={connectionMode === "external"} />;
	}
	if ((isInitializing || connectionStatus === "authenticating") && hasWallet) {
		return <LoadingHome message="Authenticating wallet…" />;
	}
	if (hasWallet) {
		return initError ? (
			<FailedWalletHome message={initError} />
		) : (
			<LoadingHome message="Unlock your wallet to continue." />
		);
	}
	return <WalletConnectCarousel />;
}
