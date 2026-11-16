"use client";

import { LockKeyhole, RefreshCw } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { MainnetOnly } from "@/components/mainnet-only";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { WalletConnectCarousel } from "@/components/wallet/wallet-connect-carousel";
import { WalletHomeActions } from "@/components/wallet/wallet-home-actions";
import { WalletHomeStatus } from "@/components/wallet/wallet-home-status";
import { WalletLocks } from "@/components/wallet/wallet-locks";
import { PRIVACY_MODE_KEY } from "@/lib/constants";
import { useSettingsStorage } from "@/lib/wallet-storage";
import { useWallet } from "@/providers/wallet-provider";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import styles from "./wallet-home.module.css";

/** The balance and its two actions, as skeletons, while the wallet opens. */
function LoadingHome({ message }: { message: string }) {
	return (
		<div className={styles.hero} role="status" aria-live="polite">
			<span className="sr-only">{message}</span>
			<div className={styles.balanceContent}>
				<div className={styles.balanceStack}>
					<div className="flex flex-col gap-3">
						<Skeleton className="h-4 w-32" />
						<Skeleton className="h-10 w-60 max-w-full" />
					</div>
					<div className="grid grid-cols-2 gap-2 sm:flex">
						<Skeleton className="h-12 sm:h-10 sm:w-32" />
						<Skeleton className="h-12 sm:h-10 sm:w-32" />
					</div>
				</div>
			</div>
		</div>
	);
}

function FailedWalletHome({ message }: { message: string }) {
	const { lockWallet } = useWallet();
	return (
		<section
			aria-label="Wallet could not be opened"
			className="flex flex-col items-start gap-4"
		>
			<Notice
				className="w-full"
				title="Wallet could not be opened"
				tone="danger"
			>
				<span className="wrap-anywhere">{message}</span>
			</Notice>
			<Button onClick={lockWallet} variant="outline">
				Lock and retry
			</Button>
		</section>
	);
}

function LockedWalletHome({ external }: { external: boolean }) {
	const { disconnectExternalWallet } = useWalletToolbox();
	return (
		<EmptyState
			action={
				external && (
					<Button
						onClick={() => void disconnectExternalWallet()}
						variant="outline"
					>
						Choose another wallet
					</Button>
				)
			}
			description={
				external
					? "Unlock your connected wallet, then reconnect."
					: "Use the unlock prompt to continue."
			}
			icon={LockKeyhole}
			title="Wallet locked"
		/>
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
				<Notice title="Wallet data could not be refreshed" tone="danger">
					<div className="flex flex-col items-start gap-3">
						<span className="wrap-anywhere">{balanceError.message}</span>
						<Button onClick={refreshBalance} size="sm" variant="outline">
							<RefreshCw data-icon="inline-start" /> Retry
						</Button>
					</div>
				</Notice>
			)}

			<section className={styles.hero} aria-labelledby="wallet-balance-heading">
				<div className={styles.balanceContent}>
					<div className={styles.balanceStack}>
						<div>
							<p className={styles.eyebrow} id="wallet-balance-heading">
								Spendable balance
							</p>
							{!balanceSupported ? (
								<div className="mt-2">
									<p className="font-semibold text-2xl text-muted-foreground">
										Provider-managed
									</p>
									<p className="mt-1 text-muted-foreground text-sm">
										Your connected wallet doesn't share its balance.
									</p>
								</div>
							) : isBalanceLoading || (!balance && !balanceError) ? (
								<div className="mt-2 flex flex-col gap-2" role="status">
									<Skeleton className="h-10 w-60 max-w-full" />
									<Skeleton className="h-4 w-28" />
									<span className="sr-only">Loading wallet balance</span>
								</div>
							) : balanceError ? (
								<p className="mt-2 font-semibold text-2xl text-muted-foreground">
									Unavailable
								</p>
							) : (
								<>
									<p
										className={styles.amount}
										data-sats={privacyMode ? undefined : balance?.total}
										data-testid="wallet-balance"
									>
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
						sizes="380px"
					/>
				</div>
			</section>

			<MainnetOnly fallback={null}>
				{connectionMode === "built-in" && legacyBalance > 0 && (
					<Notice title="Legacy balance found" tone="warning">
						<div className="flex flex-col items-start gap-3">
							<span>
								{privacyMode
									? "Funds are held on legacy addresses."
									: `${(legacyBalance / 100_000_000).toFixed(8)} BSV is held on legacy addresses.`}
							</span>
							<Button asChild size="sm" variant="outline">
								<Link href="/wallet/migrate">Review migration</Link>
							</Button>
						</div>
					</Notice>
				)}
			</MainnetOnly>
			<WalletLocks />
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
			<LockedWalletHome external={false} />
		);
	}
	return <WalletConnectCarousel />;
}
