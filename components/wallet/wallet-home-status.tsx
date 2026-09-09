"use client";

import {
	ArrowRight,
	CircleDollarSign,
	Copy,
	Gem,
	History,
	Inbox,
	LockKeyhole,
	RefreshCw,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCopyWithSound } from "@/hooks/use-copy-with-sound";
import { describeAssetSurface } from "@/lib/wallet/asset-query-state";
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

export function WalletHomeStatus() {
	const {
		bsv21State,
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
					{[
						{
							title: "Ordinals",
							href: "/wallet/ordinals",
							icon: Gem,
							state: ordinalsState,
							noun: "inscription",
						},
						{
							title: "BSV21",
							href: "/wallet/bsv21",
							icon: CircleDollarSign,
							state: bsv21State,
							noun: "token",
						},
					].map(({ title, href, icon: Icon, state, noun }) => (
						<Link key={title} href={href} className={styles.assetRow}>
							<Icon className={styles.accent} aria-hidden="true" />
							<div>
								<h3>{title}</h3>
								{isBalanceLoading ? (
									<Skeleton className="mt-2 h-4 w-24" />
								) : (
									<p className={styles.description}>
										{describeAssetSurface(state, noun)}
									</p>
								)}
							</div>
							<ArrowRight className={styles.arrow} aria-hidden="true" />
						</Link>
					))}
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
					<div className={styles.services}>
						{[
							{
								title: "Address sync",
								icon: RefreshCw,
								task: syncTasks.addresses,
							},
							{ title: "Payment inbox", icon: Inbox, task: syncTasks.payments },
							{
								title: "Token inbox",
								icon: Inbox,
								task: syncTasks.cosignDeliveries,
							},
						].map(({ title, icon: Icon, task }) => (
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
