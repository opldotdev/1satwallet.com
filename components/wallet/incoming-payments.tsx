"use client";

import { Copy } from "lucide-react";
import { useCallback, useSyncExternalStore } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { SectionHeader } from "@/components/ui/section-header";
import { useCopyWithSound } from "@/hooks/use-copy-with-sound";
import { truncatePresenceIdentity } from "@/lib/p2p-presence";
import {
	actionAmountLabel,
	actionDateLabel,
} from "@/lib/wallet/action-history";
import {
	type IncomingPaymentRecord,
	type IncomingPaymentsState,
	loadIncomingPayments,
	subscribeIncomingPayments,
} from "@/lib/wallet/incoming-payments";
import { messageboxHostName } from "@/lib/wallet/peerpay-inbox";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

const NONE: IncomingPaymentsState = { records: [], unreachableHosts: [] };

/** A received payment needs no badge: its amount in the brand colour says so. */
const STATUS_LABEL: Partial<Record<IncomingPaymentRecord["status"], string>> = {
	failed: "Failed",
	unreadable: "Not accepted",
};

let storageErrorLogged = false;

/** PeerPay payments the sync took from this account's MessageBoxes. */
export function IncomingPayments() {
	const { chain, identityKey, connectionMode } = useWalletToolbox();
	const [, copy] = useCopyWithSound();
	const read = useCallback(() => {
		if (!identityKey) return NONE;
		try {
			return loadIncomingPayments({ chain, identityKey });
		} catch (error) {
			if (!storageErrorLogged) {
				storageErrorLogged = true;
				console.error("[incoming-payments] storage unavailable", error);
			}
			return NONE;
		}
	}, [chain, identityKey]);
	const { records, unreachableHosts } = useSyncExternalStore(
		subscribeIncomingPayments,
		read,
		() => NONE,
	);

	if (connectionMode !== "built-in" || !identityKey) return null;

	return (
		<section aria-label="Incoming payments" className="flex flex-col gap-3">
			<SectionHeader
				title="Incoming payments"
				description="PeerPay payments sent to your identity key. Each sync takes in new ones and retries any that failed; one that can't be accepted stays in its MessageBox."
			/>
			{unreachableHosts.length > 0 && (
				<Notice tone="warning">
					Couldn't reach{" "}
					<span className="font-mono">
						{unreachableHosts.map(messageboxHostName).join(", ")}
					</span>{" "}
					on the last sync. Payments waiting there come in once it answers.
				</Notice>
			)}
			{records.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					No PeerPay payments yet.
				</p>
			) : (
				<ul className="flex flex-col divide-y divide-border/60">
					{records.map((record) => {
						const time = Date.parse(record.createdAt);
						const status = STATUS_LABEL[record.status];
						return (
							<li
								key={record.key}
								data-slot="incoming-payment-row"
								className="flex min-h-14 flex-col justify-center gap-1 py-3"
							>
								<div className="flex items-center justify-between gap-3">
									<div className="flex min-w-0 items-center gap-1 text-sm">
										<span className="text-muted-foreground">From</span>
										<span
											className="truncate font-mono font-medium"
											title={record.sender}
										>
											{truncatePresenceIdentity(record.sender)}
										</span>
										{/* 44px to tap on phones; the negative margin keeps the
										    row as tall as its text. */}
										<Button
											type="button"
											aria-label="Copy sender identity key"
											onClick={() => void copy(record.sender)}
											size="icon-sm"
											variant="ghost"
											className="-my-1.5 text-muted-foreground max-md:-my-3"
										>
											<Copy />
										</Button>
									</div>
									<span
										className={`shrink-0 font-mono text-sm tabular-nums ${record.status === "received" ? "text-primary" : "text-muted-foreground"}`}
									>
										{actionAmountLabel(record.satoshis)}
									</span>
								</div>
								<div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
									{Number.isFinite(time) && (
										<time
											className="min-w-0 truncate"
											dateTime={record.createdAt}
											title={new Date(time).toLocaleString()}
										>
											{actionDateLabel(time)}
										</time>
									)}
									{status && (
										<Badge
											variant={
												record.status === "failed" ? "destructive" : "outline"
											}
											className="ml-auto shrink-0 rounded-full px-2 font-medium"
										>
											{status}
										</Badge>
									)}
								</div>
								{status && record.reason && (
									<p
										className={`text-xs ${record.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
									>
										{record.reason}
									</p>
								)}
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
