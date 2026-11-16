"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ArrowLeft,
	Copy,
	ExternalLink,
	Loader2,
	RefreshCw,
	Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	OneColorChips,
	OneColorGate,
	OneColorIcon,
	OneColorLoading,
	OneColorNotice,
} from "@/components/wallet/one-color-grid";
import { useCopyWithSound } from "@/hooks/use-copy-with-sound";
import { oneColorBalancesQueryKey } from "@/hooks/use-one-color-balances";
import {
	flattenOneColorHistory,
	useOneColorHistory,
} from "@/hooks/use-one-color-history";
import { useOneColorToken } from "@/hooks/use-one-color-token";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import { actionExplorerUrl } from "@/lib/wallet/action-history";
import { formatBsv21Amount } from "@/lib/wallet/bsv21-actions";
import { NoColorOverlayError } from "@/lib/wallet/color-overlay";
import {
	ONE_COLOR_SCAN_MAX,
	type OneColorBalance,
	type OneColorDirection,
	type OneColorHistoryEntry,
	oneColorTicker,
} from "@/lib/wallet/one-color";
import type { OneColorSendOutcome } from "@/lib/wallet/one-color-actions";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import { OneColorReceiveDialog } from "./one-color-receive";
import { OneColorPendingSends, OneColorSendDialog } from "./one-color-send";

type DeliveredSend = Exclude<OneColorSendOutcome, { kind: "failed" }>;

const DIRECTION_LABEL: Record<OneColorDirection, string> = {
	received: "Received",
	sent: "Sent",
	transfer: "Transfer",
};

function useOverlayOrigin(assetId: string) {
	const { chain, identityKey, colorOverlay } = useWalletToolbox();
	return useQuery({
		queryKey: [
			...oneColorBalancesQueryKey(chain, identityKey),
			"overlay",
			assetId,
		],
		enabled: colorOverlay !== null,
		retry: false,
		queryFn: async () => {
			if (!colorOverlay) throw new NoColorOverlayError(assetId);
			try {
				return await colorOverlay.resolveOrigin(assetId);
			} catch (error) {
				// No overlay for the token is a normal state ("None configured").
				if (error instanceof NoColorOverlayError) throw error;
				console.error(`[1color] overlay of ${assetId} not resolved:`, error);
				reportDiagnostic({
					category: "provider",
					code: "provider.failed",
					operation: "wallet.1color.overlay-origin",
					recoverable: true,
					context: { retryable: true },
				});
				throw error;
			}
		},
	});
}

/**
 * Receive, Send and Mint. Mint is offered only to an authority holder and
 * stays disabled until its batch lands.
 */
function OneColorActions({
	token,
	onSendStart,
	onSendOutcome,
}: {
	token: OneColorBalance;
	onSendStart: () => void;
	onSendOutcome: (outcome: DeliveredSend) => void;
}) {
	return (
		<div className="space-y-1">
			<div className="flex flex-wrap gap-2">
				<OneColorReceiveDialog />
				<OneColorSendDialog
					token={token}
					onStart={onSendStart}
					onOutcome={onSendOutcome}
				/>
				{token.authorities > 0 ? (
					<Button size="sm" variant="outline" disabled>
						<Sparkles className="size-4" data-icon="inline-start" /> Mint
					</Button>
				) : null}
			</div>
			{token.authorities > 0 ? (
				<p className="text-xs text-muted-foreground">
					Mint isn't available yet.
				</p>
			) : null}
		</div>
	);
}

function HistoryRow({
	entry,
	dec,
}: {
	entry: OneColorHistoryEntry;
	dec: number;
}) {
	const { chain } = useWalletToolbox();
	const { action, direction, amount } = entry;
	const explorerUrl = actionExplorerUrl(action.txid, chain);
	return (
		<li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
			<div className="min-w-0 flex-1">
				<div className="text-sm">
					{action.description || DIRECTION_LABEL[direction]}
				</div>
				{explorerUrl ? (
					<a
						href={explorerUrl}
						target="_blank"
						rel="noreferrer"
						className="inline-flex items-center gap-1 break-all font-mono text-[11px] text-muted-foreground hover:text-primary"
					>
						{action.txid} <ExternalLink className="size-3" />
					</a>
				) : (
					<div className="break-all font-mono text-[11px] text-muted-foreground">
						{action.txid}
					</div>
				)}
			</div>
			<div className="flex max-w-full flex-wrap items-center justify-end gap-2">
				<Badge variant="outline" className="text-[10px]">
					{DIRECTION_LABEL[direction]}
				</Badge>
				<Badge variant="secondary" className="text-[10px]">
					{action.status}
				</Badge>
				<span
					className={`font-mono text-sm ${direction === "received" ? "text-primary" : "text-muted-foreground"}`}
				>
					{direction === "transfer"
						? "No net change"
						: `${direction === "sent" ? "−" : "+"}${formatBsv21Amount(amount, dec)}`}
				</span>
			</div>
		</li>
	);
}

function OneColorHistory({ assetId, dec }: { assetId: string; dec: number }) {
	const { colorContext } = useWalletToolbox();
	const history = useOneColorHistory(assetId);

	if (!colorContext) {
		return (
			<p className="text-sm text-muted-foreground">
				History is available once the wallet's 1Color module is ready.
			</p>
		);
	}

	if (history.isPending) {
		return (
			<div
				role="status"
				className="flex items-center gap-2 text-sm text-muted-foreground"
			>
				<Loader2 className="size-4 animate-spin" /> Loading history…
			</div>
		);
	}

	if (history.isError) {
		return (
			<div
				role="alert"
				className="flex flex-wrap items-center gap-3 text-sm text-destructive"
			>
				<span>Couldn't load this token's history.</span>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => void history.refetch()}
				>
					<RefreshCw data-icon="inline-start" /> Retry
				</Button>
			</div>
		);
	}

	const { entries, truncated } = flattenOneColorHistory(history.data.pages);
	const olderNote = truncated ? (
		<p className="text-xs text-muted-foreground">
			Older history isn't shown: only the newest{" "}
			{ONE_COLOR_SCAN_MAX.toLocaleString()} transactions are searched.
		</p>
	) : null;
	if (entries.length === 0) {
		return (
			<div className="space-y-2">
				<p className="text-sm text-muted-foreground">
					No transactions found for this token.
				</p>
				{olderNote}
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<ul className="flex flex-col divide-y divide-border/60">
				{entries.map((entry) => (
					<HistoryRow key={entry.action.txid} entry={entry} dec={dec} />
				))}
			</ul>
			{history.hasNextPage ? (
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={history.isFetchingNextPage}
					onClick={() => void history.fetchNextPage()}
				>
					{history.isFetchingNextPage ? (
						<Loader2 className="size-4 animate-spin" data-icon="inline-start" />
					) : null}
					Load more
				</Button>
			) : null}
			{olderNote}
		</div>
	);
}

function OneColorDetailBody({ assetId }: { assetId: string }) {
	const { chain, identityKey, colorOverlay } = useWalletToolbox();
	const queryClient = useQueryClient();
	const [, copy] = useCopyWithSound();
	const { state, retry } = useOneColorToken(assetId);
	const overlay = useOverlayOrigin(assetId);
	const [lastSend, setLastSend] = useState<DeliveredSend | null>(null);
	const [undelivered, setUndelivered] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const onSendStart = useCallback(() => setLastSend(null), []);
	const onSendOutcome = useCallback((outcome: DeliveredSend) => {
		setLastSend(outcome);
		if (outcome.kind === "undelivered") {
			setUndelivered((previous) => new Set([...previous, outcome.txid]));
		}
	}, []);
	// The last send's result no longer holds once a cancel was asked of it.
	const onCancelOutcome = useCallback(
		(txid: string) =>
			setLastSend((previous) => (previous?.txid === txid ? null : previous)),
		[],
	);

	if (state.kind === "loading")
		return <OneColorLoading label="Loading 1Color token…" />;
	if (state.kind === "not-a-token") {
		return (
			<OneColorNotice>
				<p>This isn't a 1Color token.</p>
			</OneColorNotice>
		);
	}
	if (state.kind === "error") {
		return (
			<OneColorNotice>
				<p>Couldn't load this 1Color token.</p>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="mt-3"
					onClick={retry}
				>
					<RefreshCw data-icon="inline-start" /> Retry
				</Button>
			</OneColorNotice>
		);
	}

	const { token } = state;
	const ticker = oneColorTicker(token);
	const overlayText = !colorOverlay
		? "Unavailable"
		: overlay.isSuccess
			? overlay.data
			: overlay.error instanceof NoColorOverlayError
				? "None configured"
				: overlay.isError
					? "Couldn't load"
					: "…";

	return (
		<div className="space-y-6">
			<header className="flex flex-col gap-5 sm:flex-row sm:items-start">
				<OneColorIcon icon={token.icon} size={80} />
				<div className="min-w-0 flex-1 space-y-2">
					<div className="flex flex-wrap items-center gap-2">
						<h1 className="min-w-0 text-3xl font-bold wrap-anywhere">
							{ticker}
						</h1>
						<OneColorChips authorities={token.authorities} />
					</div>
					<div className="flex items-center gap-1">
						<p className="break-all font-mono text-xs text-muted-foreground">
							{assetId}
						</p>
						<Button
							aria-label="Copy asset id"
							title="Copy asset id"
							onClick={() => void copy(assetId)}
							size="icon"
							variant="ghost"
						>
							<Copy />
						</Button>
					</div>
					<OneColorActions
						token={token}
						onSendStart={onSendStart}
						onSendOutcome={onSendOutcome}
					/>
					{lastSend ? (
						<p
							className={`text-sm ${lastSend.kind === "sent" ? "text-primary" : "text-destructive"}`}
							role={lastSend.kind === "sent" ? "status" : "alert"}
						>
							{lastSend.message}
						</p>
					) : null}
				</div>
			</header>
			<dl className="grid gap-4 rounded-md border p-4 sm:grid-cols-2 lg:grid-cols-4">
				<div>
					<dt className="text-xs text-muted-foreground">Available</dt>
					<dd className="mt-1 break-all font-mono">
						{formatBsv21Amount(token.available, token.dec)}
					</dd>
				</div>
				<div>
					<dt className="text-xs text-muted-foreground">Pending</dt>
					<dd className="mt-1 break-all font-mono">
						{formatBsv21Amount(token.pending, token.dec)}
					</dd>
					<dd className="mt-1 text-xs text-muted-foreground">
						In sends not yet claimed by the recipient.
					</dd>
				</div>
				<div>
					<dt className="text-xs text-muted-foreground">Authorities</dt>
					<dd className="mt-1 font-mono">{token.authorities}</dd>
				</div>
				<div>
					<dt className="text-xs text-muted-foreground">Decimals</dt>
					<dd className="mt-1 font-mono">{token.dec}</dd>
				</div>
				<div className="sm:col-span-2 lg:col-span-4">
					<dt className="text-xs text-muted-foreground">Overlay</dt>
					<dd className="mt-1 break-all font-mono text-sm">{overlayText}</dd>
				</div>
			</dl>
			<OneColorPendingSends
				token={token}
				undelivered={undelivered}
				onCancelOutcome={onCancelOutcome}
			/>
			<section aria-labelledby="one-color-history" className="space-y-3">
				<div className="flex items-center justify-between gap-3">
					<h2 id="one-color-history" className="text-lg font-medium">
						History
					</h2>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() =>
							void queryClient.invalidateQueries({
								queryKey: oneColorBalancesQueryKey(chain, identityKey),
							})
						}
					>
						<RefreshCw data-icon="inline-start" /> Refresh
					</Button>
				</div>
				<OneColorHistory assetId={assetId} dec={token.dec} />
			</section>
		</div>
	);
}

/** One 1Color token: balances, overlay, actions and history. */
export default function OneColorDetail({ assetId }: { assetId: string }) {
	return (
		<div className="space-y-6">
			<Link
				className="inline-flex items-center rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				href="/wallet/1color"
			>
				<ArrowLeft className="mr-2 size-4" /> Back to 1Color tokens
			</Link>
			<OneColorGate>
				<OneColorDetailBody assetId={assetId} />
			</OneColorGate>
		</div>
	);
}
