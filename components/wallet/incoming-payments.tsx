"use client";

import { Copy } from "lucide-react";
import { useCallback, useSyncExternalStore } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCopyWithSound } from "@/hooks/use-copy-with-sound";
import { truncatePresenceIdentity } from "@/lib/p2p-presence";
import { actionAmountLabel } from "@/lib/wallet/action-history";
import {
	type IncomingPaymentRecord,
	type IncomingPaymentsState,
	loadIncomingPayments,
	subscribeIncomingPayments,
} from "@/lib/wallet/incoming-payments";
import { messageboxHostName } from "@/lib/wallet/peerpay-inbox";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

const NONE: IncomingPaymentsState = { records: [], unreachableHosts: [] };

const STATUS_LABEL: Record<IncomingPaymentRecord["status"], string> = {
	received: "Received",
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
		<section className="space-y-3">
			<div>
				<h2 className="font-mono text-xl font-medium">Incoming payments</h2>
				<p className="text-sm text-muted-foreground">
					PeerPay payments sent to your identity key. Each sync takes new ones
					into the wallet and tries a failed one again; one that can't be
					accepted stays in its MessageBox.
				</p>
			</div>
			{unreachableHosts.length > 0 && (
				<p className="text-sm text-destructive">
					Couldn't read{" "}
					<code className="font-mono">
						{unreachableHosts.map(messageboxHostName).join(", ")}
					</code>{" "}
					on the last sync. Payments waiting there come in once it answers.
				</p>
			)}
			{records.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					No PeerPay payments yet.
				</p>
			) : (
				<ul className="flex flex-col divide-y divide-border/60">
					{records.map((record) => (
						<li
							key={record.key}
							className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
						>
							<div className="min-w-0 flex-1 space-y-1">
								<div className="flex items-center gap-1 text-sm">
									<span className="text-muted-foreground">From</span>
									<code className="font-mono" title={record.sender}>
										{truncatePresenceIdentity(record.sender)}
									</code>
									<Button
										aria-label="Copy sender identity key"
										onClick={() => void copy(record.sender)}
										size="icon"
										variant="ghost"
										className="size-6"
									>
										<Copy className="size-3" />
									</Button>
								</div>
								<time
									className="block text-xs text-muted-foreground"
									dateTime={record.createdAt}
								>
									{new Date(record.createdAt).toLocaleString()}
								</time>
								{record.status !== "received" && record.reason && (
									<p
										className={`text-xs ${record.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
									>
										{record.reason}
									</p>
								)}
							</div>
							<div className="flex items-center gap-2">
								<Badge
									variant={
										record.status === "failed" ? "destructive" : "outline"
									}
									className="text-[10px]"
								>
									{STATUS_LABEL[record.status]}
								</Badge>
								<span
									className={`font-mono text-sm ${record.status === "received" ? "text-primary" : "text-muted-foreground"}`}
								>
									{actionAmountLabel(record.satoshis)}
								</span>
							</div>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
