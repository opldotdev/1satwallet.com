"use client";

import {
	ArrowRight,
	AtSign,
	Coins,
	Copy,
	Gem,
	History,
	Inbox,
	LockKeyhole,
	type LucideIcon,
	RefreshCw,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCopyWithSound } from "@/hooks/use-copy-with-sound";
import { useOneColorBalances } from "@/hooks/use-one-color-balances";
import { useWalletHandles } from "@/hooks/use-wallet-handles";
import { endpointsOf, isOneColorAvailable } from "@/lib/chain-endpoints";
import { type WalletTabValue, walletTabsFor } from "@/lib/chain-surfaces";
import { useWalletChain } from "@/lib/hooks/use-wallet-chain";
import {
	assetSurfaceFromCount,
	describeAssetSurface,
} from "@/lib/wallet/asset-query-state";
import type { SyncTaskState } from "@/providers/hooks/use-sync-engine";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import styles from "./wallet-home.module.css";

function describeSyncTask(task: SyncTaskState) {
	if (task.status === "provider-managed") return "Managed by connected wallet";
	if (task.status === "running") return "Checking now";
	if (task.status === "failed") return task.error ?? "Needs retry";
	if (task.lastRunAt === null) return "Waiting for first check";
	const time = new Date(task.lastRunAt).toISOString().slice(11, 19);
	return `Processed ${task.processed ?? "unknown"}, failed ${task.failed ?? "unknown"} · ${time} UTC`;
}

/** Testnet only: where to get test coins, shown under the balance. */
export function TestnetFaucetLink() {
	const chain = useWalletChain();
	const { faucet } = endpointsOf(chain);
	if (chain !== "test" || !faucet) return null;
	return (
		<a
			className="inline-flex w-fit items-center text-muted-foreground text-xs underline underline-offset-4 hover:text-foreground max-md:min-h-11"
			href={faucet}
			rel="noopener noreferrer"
			target="_blank"
		>
			Get test coins
		</a>
	);
}

/** The Tokens row's line: BSV-21, and on testnet 1Color too. */
function TokensDescription() {
	const chain = useWalletChain();
	const { bsv21State, connectionMode } = useWalletToolbox();
	const oneColor = useOneColorBalances();
	const bsv21 = describeAssetSurface(bsv21State, "BSV-21 token");
	// 1Color is read from the built-in wallet only, on a chain with an overlay.
	if (!isOneColorAvailable(chain) || connectionMode !== "built-in") {
		return bsv21;
	}
	const colored = oneColor.isPending
		? "1Color loading"
		: oneColor.isError
			? "1Color couldn't load"
			: describeAssetSurface(
					assetSurfaceFromCount(oneColor.data.length),
					"1Color token",
				);
	return `${bsv21} · ${colored}`;
}

/** The sections that hold assets, as rows of the overview's Assets list. */
const ASSET_ICONS: Partial<Record<WalletTabValue, LucideIcon>> = {
	ordinals: Gem,
	tokens: Coins,
	opns: AtSign,
};

export function WalletHomeStatus() {
	const {
		connectionMode,
		hasActiveSync,
		identityKey,
		isBalanceLoading,
		ordinalsState,
		syncStatus,
		syncTasks,
		syncWallet,
	} = useWalletToolbox();
	const [, copy] = useCopyWithSound();
	const assets = walletTabsFor(useWalletChain()).filter(
		(tab) => ASSET_ICONS[tab.value] !== undefined,
	);
	const describe = (value: WalletTabValue) =>
		value === "ordinals" ? (
			describeAssetSurface(ordinalsState, "inscription")
		) : value === "tokens" ? (
			<TokensDescription />
		) : (
			"Names you own"
		);
	const handles = useWalletHandles();
	const holdsHandle = (handles.data?.length ?? 0) > 0;
	const shortenedIdentity = identityKey
		? `${identityKey.slice(0, 14)}…${identityKey.slice(-10)}`
		: "Unavailable";

	return (
		<>
			<div className={styles.details}>
				<section
					className={styles.assets}
					aria-labelledby="wallet-assets-heading"
				>
					<h2 id="wallet-assets-heading">Assets</h2>
					<p className={styles.description}>Your on-chain assets and tokens.</p>
					{assets.map(({ value, label, href }) => {
						const Icon = ASSET_ICONS[value] ?? Coins;
						return (
							<Link key={value} href={href} className={styles.assetRow}>
								<Icon className={styles.accent} aria-hidden="true" />
								<div>
									<h3>{label}</h3>
									{isBalanceLoading ? (
										<Skeleton className="mt-2 h-4 w-24" />
									) : (
										<p className={styles.description}>{describe(value)}</p>
									)}
								</div>
								<ArrowRight className={styles.arrow} aria-hidden="true" />
							</Link>
						);
					})}
				</section>
				<section
					className={styles.connection}
					aria-labelledby="wallet-connection-heading"
				>
					<h2 id="wallet-connection-heading">Wallet connection</h2>
					<p className={styles.description}>
						{connectionMode === "external"
							? "Services managed by your connected wallet."
							: "Sync and delivery status for your wallet."}
					</p>
					<div>
						{[
							{
								id: "addresses",
								title: "Address sync",
								icon: RefreshCw,
								task: syncTasks.addresses,
							},
							{
								id: "payments",
								title: "Payment inbox",
								icon: Inbox,
								task: syncTasks.payments,
							},
							{
								id: "cosign-deliveries",
								title: "Token inbox",
								icon: Inbox,
								task: syncTasks.cosignDeliveries,
							},
							// Only a wallet holding a handle has a handle inbox.
							...(holdsHandle
								? [
										{
											id: "handle-inbox",
											title: "Handle inbox",
											icon: AtSign,
											task: syncTasks.handleInbox,
										},
									]
								: []),
						].map(({ id, title, icon: Icon, task }) => (
							<div key={title} className={styles.serviceRow}>
								<Icon
									className={`${styles.accent} ${task.status === "running" ? "motion-safe:animate-spin" : ""}`}
									aria-hidden="true"
								/>
								<div className="min-w-0">
									<h3>{title}</h3>
									<p className={`${styles.description} break-words`}>
										{describeSyncTask(task)}
									</p>
								</div>
								<span
									className={`${styles.taskStatus} ${task.status === "failed" ? styles.failed : ""}`}
									data-state={task.status}
									data-task={id}
									data-testid="wallet-sync-state"
								>
									{task.status === "provider-managed"
										? "Provider managed"
										: task.status === "failed"
											? "Retry available"
											: task.status}
								</span>
							</div>
						))}
					</div>
					{connectionMode === "built-in" && (
						<Button
							disabled={hasActiveSync}
							onClick={syncWallet}
							size="sm"
							variant="ghost"
						>
							<RefreshCw
								className={hasActiveSync ? "motion-safe:animate-spin" : ""}
							/>
							{syncStatus.error ? "Retry sync" : "Sync now"}
						</Button>
					)}
				</section>
				<Link href="/wallet/history" className={styles.activity}>
					<History className={styles.accent} aria-hidden="true" />
					<div>
						<h3>Activity</h3>
						<p className={styles.description}>
							Review wallet actions and transaction status.
						</p>
					</div>
					<span className={styles.historyLink}>
						Open history <ArrowRight aria-hidden="true" />
					</span>
				</Link>
			</div>
			<div className={styles.identity}>
				<LockKeyhole className={styles.accent} aria-hidden="true" />
				<div>
					<h3>Authenticated identity</h3>
					<p className={styles.description}>
						BRC-100 identity currently authorizing this wallet session.
					</p>
				</div>
				<code>{shortenedIdentity}</code>
				<Button
					aria-label="Copy authenticated identity key"
					disabled={!identityKey}
					onClick={() => identityKey && void copy(identityKey)}
					size="icon"
					variant="ghost"
				>
					<Copy />
				</Button>
				<span className={styles.protocol}>BRC-100</span>
			</div>
		</>
	);
}
