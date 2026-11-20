"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useSound } from "@/hooks/use-sound";
import type { Chain } from "@/lib/chain-endpoints";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import {
	listPendingHandleSends,
	type PendingHandleSend,
	runHandleSendCancel,
} from "@/lib/wallet/bsv-send";
import {
	livePeerPayDeps,
	type PeerPayOutboxEntry,
	peerPayOutbox,
	peerPayOutboxKey,
	retryPeerPayDelivery,
} from "@/lib/wallet/peerpay-send";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import { formatSatoshisAsBsv } from "./wallet-home-utils";

/** Under `["wallet-actions"]`, so a send's invalidation re-reads it. */
export const pendingHandleSendsQueryKey = (
	chain: Chain,
	identityKey: string | null,
) => ["wallet-actions", "handle-pending", chain, identityKey] as const;

const short = (key: string) => `${key.slice(0, 8)}…${key.slice(-6)}`;

/** The account's PeerPay outbox, re-read on this tab's and other tabs' changes. */
export function usePeerPayOutbox(chain: Chain, identityKey: string | null) {
	const [entries, setEntries] = useState<PeerPayOutboxEntry[]>([]);
	const reload = useCallback(() => {
		if (!identityKey || typeof window === "undefined") {
			setEntries([]);
			return;
		}
		try {
			setEntries(peerPayOutbox(window.localStorage, chain, identityKey).list());
		} catch (error) {
			console.error("[peerpay-send] reading the outbox failed", { error });
			setEntries([]);
		}
	}, [chain, identityKey]);
	useEffect(() => {
		reload();
		if (!identityKey) return;
		const key = peerPayOutboxKey(chain, identityKey);
		const onStorage = (event: StorageEvent) => {
			if (event.key === null || event.key === key) reload();
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, [chain, identityKey, reload]);
	return { entries, reload };
}

function PeerPayRow({
	entry,
	onDone,
}: {
	entry: PeerPayOutboxEntry;
	onDone: () => void;
}) {
	const { wallet, chain, identityKey } = useWalletToolbox();
	const { play } = useSound();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const inFlight = useRef(false);
	const outbox = identityKey
		? peerPayOutbox(window.localStorage, chain, identityKey)
		: null;

	const retry = async () => {
		if (!wallet || !outbox || inFlight.current) return;
		inFlight.current = true;
		setBusy(true);
		setError(null);
		const result = await retryPeerPayDelivery(entry, {
			deliver: livePeerPayDeps(wallet, chain).deliver,
			outbox,
		});
		if (result.ok) {
			play("success");
			onDone();
		} else {
			setError(result.message);
			play("error");
		}
		setBusy(false);
		inFlight.current = false;
	};

	const discard = () => {
		if (!outbox) return;
		try {
			outbox.remove(entry.txid);
		} catch (error) {
			console.error("[peerpay-send] discarding failed", {
				txid: entry.txid,
				error,
			});
			setError("This payment couldn't be removed. Try again.");
			return;
		}
		onDone();
	};

	return (
		<li className="space-y-2 rounded-md border p-3 text-sm">
			<p>
				<span className="font-mono">
					{formatSatoshisAsBsv(entry.satoshis)} BSV
				</span>{" "}
				to <span className="font-mono">{short(entry.recipient)}</span>
			</p>
			<p className="text-muted-foreground text-xs">
				Paid, not yet delivered to their MessageBox. Retry delivery sends this
				same payment, so it can&apos;t pay twice.
			</p>
			{error ? (
				<p className="text-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}
			{confirmDiscard ? (
				<div className="space-y-2">
					<p className="text-xs">
						Without delivery they can&apos;t claim these coins, and this wallet
						can&apos;t take them back. Discard anyway?
					</p>
					<div className="flex gap-2">
						<Button
							onClick={() => setConfirmDiscard(false)}
							size="sm"
							variant="outline"
						>
							Keep
						</Button>
						<Button onClick={discard} size="sm" variant="destructive">
							Discard
						</Button>
					</div>
				</div>
			) : (
				<div className="flex gap-2">
					<Button
						disabled={busy || !wallet}
						onClick={() => void retry()}
						size="sm"
					>
						{busy ? (
							<Loader2 className="animate-spin" data-icon="inline-start" />
						) : null}
						Retry delivery
					</Button>
					<Button
						disabled={busy}
						onClick={() => setConfirmDiscard(true)}
						size="sm"
						variant="ghost"
					>
						Discard
					</Button>
				</div>
			)}
		</li>
	);
}

function HandleSendRow({ send }: { send: PendingHandleSend }) {
	const { oneSatContext, refreshBalance } = useWalletToolbox();
	const queryClient = useQueryClient();
	const { play } = useSound();
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<{
		tone: "info" | "error";
		text: string;
	} | null>(null);
	const inFlight = useRef(false);

	const cancel = async () => {
		if (!oneSatContext || inFlight.current) return;
		inFlight.current = true;
		setBusy(true);
		const outcome = await runHandleSendCancel(oneSatContext.wallet, send);
		setResult({
			tone: outcome.kind === "failed" ? "error" : "info",
			text: outcome.message,
		});
		play(outcome.kind === "requested" ? "success" : "error");
		setConfirming(false);
		setBusy(false);
		inFlight.current = false;
		refreshBalance();
		void queryClient.invalidateQueries({ queryKey: ["wallet-actions"] });
	};

	return (
		<li className="space-y-2 rounded-md border p-3 text-sm">
			<p>
				{send.satoshis !== null ? (
					<span className="font-mono">
						{formatSatoshisAsBsv(send.satoshis)} BSV
					</span>
				) : (
					"A payment"
				)}{" "}
				to <span className="font-mono">{send.handle ?? "a handle"}</span>
			</p>
			{result ? (
				<p
					className={
						result.tone === "error"
							? "text-destructive text-xs"
							: "text-muted-foreground text-xs"
					}
					role={result.tone === "error" ? "alert" : "status"}
				>
					{result.text}
				</p>
			) : null}
			{confirming ? (
				<div className="space-y-2">
					<p className="text-xs">
						The wallet asks the network for the coins back. If the recipient
						claims them first, they keep them.
					</p>
					<div className="flex gap-2">
						<Button
							disabled={busy}
							onClick={() => setConfirming(false)}
							size="sm"
							variant="outline"
						>
							Keep payment
						</Button>
						<Button
							disabled={busy}
							onClick={() => void cancel()}
							size="sm"
							variant="destructive"
						>
							{busy ? (
								<Loader2 className="animate-spin" data-icon="inline-start" />
							) : null}
							Cancel payment
						</Button>
					</div>
				</div>
			) : result?.tone === "info" ? (
				<Badge variant="secondary">Cancel requested</Badge>
			) : (
				<Button
					disabled={!oneSatContext}
					onClick={() => setConfirming(true)}
					size="sm"
					variant="outline"
				>
					Cancel
				</Button>
			)}
		</li>
	);
}

/**
 * BSV payments that went out but aren't settled with the recipient: PeerPay
 * payments not yet delivered (Retry delivery), and handle payments waiting
 * to be claimed (Cancel). Shown only when there is something to show.
 */
export function BsvPendingSends() {
	const { chain, identityKey, oneSatContext } = useWalletToolbox();
	const outbox = usePeerPayOutbox(chain, identityKey);
	const handleSends = useQuery({
		queryKey: pendingHandleSendsQueryKey(chain, identityKey),
		enabled: oneSatContext !== null,
		queryFn: async () => {
			if (!oneSatContext) throw new Error("No wallet to read payments from.");
			try {
				return await listPendingHandleSends(oneSatContext.wallet);
			} catch (error) {
				console.error("[wallet.bsv.handle-pending] listing failed", {
					chain,
					error,
				});
				reportDiagnostic({
					category: "provider",
					code: "provider.failed",
					operation: "wallet.bsv.handle-pending",
					recoverable: true,
					context: { retryable: true },
				});
				throw error;
			}
		},
	});

	const sends = handleSends.data?.sends ?? [];
	if (
		outbox.entries.length === 0 &&
		sends.length === 0 &&
		!handleSends.isError
	) {
		return null;
	}

	return (
		<section aria-labelledby="bsv-pending-sends" className="space-y-3">
			<h3 className="font-medium text-sm" id="bsv-pending-sends">
				Waiting to be claimed
			</h3>
			{handleSends.isError ? (
				<div className="flex items-center gap-2 text-sm" role="alert">
					<span className="text-destructive">
						Handle payments couldn&apos;t be read from the wallet.
					</span>
					<Button
						onClick={() => void handleSends.refetch()}
						size="sm"
						variant="outline"
					>
						Try again
					</Button>
				</div>
			) : null}
			<ul className="space-y-2">
				{outbox.entries.map((entry) => (
					<PeerPayRow entry={entry} key={entry.txid} onDone={outbox.reload} />
				))}
				{sends.map((send) => (
					<HandleSendRow key={send.txid} send={send} />
				))}
			</ul>
			{handleSends.data?.truncated ? (
				<p className="text-muted-foreground text-xs">
					Only the most recent activity was checked.
				</p>
			) : null}
		</section>
	);
}
