"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Coins, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DetailRow } from "@/components/ui/detail-list";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
import {
	OneColorAuthorityChip,
	OneColorExternalWallet,
	OneColorLoading,
	OneColorNotice,
	useOneColorAccess,
} from "@/components/wallet/one-color-grid";
import { oneColorBalancesQueryKey } from "@/hooks/use-one-color-balances";
import {
	flattenOneColorHistory,
	useOneColorHistory,
} from "@/hooks/use-one-color-history";
import { useOneColorToken } from "@/hooks/use-one-color-token";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import { cn } from "@/lib/utils";
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
import { shortTxid } from "@/lib/wallet/wallet-output-utils";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import { OneColorMintDialog } from "./one-color-mint";
import { OneColorReceiveDialog } from "./one-color-receive";
import { OneColorPendingSends, OneColorSendDialog } from "./one-color-send";
import { TokenDetailLayout } from "./token-detail-layout";

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

/** Receive, Send and Mint. Mint is offered only to an authority holder. */
function OneColorActions({
	token,
	onWriteStart,
	onSendOutcome,
	onMinted,
	onMintFailed,
}: {
	token: OneColorBalance;
	/** A send or mint is starting: the last one's result no longer applies. */
	onWriteStart: () => void;
	onSendOutcome: (outcome: DeliveredSend) => void;
	onMinted: (message: string) => void;
	onMintFailed: (message: string) => void;
}) {
	return (
		<>
			<OneColorReceiveDialog />
			<OneColorSendDialog
				token={token}
				onStart={onWriteStart}
				onOutcome={onSendOutcome}
			/>
			<OneColorMintDialog
				token={token}
				onStart={onWriteStart}
				onMinted={onMinted}
				onFailed={onMintFailed}
			/>
		</>
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
						className="inline-flex items-center gap-1 break-all font-mono text-xs text-muted-foreground hover:text-primary"
					>
						{shortTxid(action.txid)} <ExternalLink className="size-3" />
					</a>
				) : (
					<div
						className="font-mono text-xs text-muted-foreground"
						title={action.txid}
					>
						{shortTxid(action.txid)}
					</div>
				)}
			</div>
			<div className="flex max-w-full flex-wrap items-center justify-end gap-2">
				<Badge variant="outline" className="text-xs">
					{DIRECTION_LABEL[direction]}
				</Badge>
				<Badge variant="secondary" className="text-xs">
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

// Shown in every state of the page: a failed re-read after a mint must not hide its outcome.
function LastMintNotice({
	lastMint,
	className,
}: {
	lastMint: { ok: boolean; message: string } | null;
	className?: string;
}) {
	if (!lastMint) return null;
	return (
		<p
			className={cn(
				"text-sm",
				lastMint.ok ? "text-primary" : "text-destructive",
				className,
			)}
			role={lastMint.ok ? "status" : "alert"}
		>
			{lastMint.message}
		</p>
	);
}

function OneColorDetailBody({ assetId }: { assetId: string }) {
	const { chain, identityKey, colorOverlay } = useWalletToolbox();
	const queryClient = useQueryClient();
	const { state, retry } = useOneColorToken(assetId);
	const overlay = useOverlayOrigin(assetId);
	const [lastSend, setLastSend] = useState<DeliveredSend | null>(null);
	const [undelivered, setUndelivered] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const [lastMint, setLastMint] = useState<{
		ok: boolean;
		message: string;
	} | null>(null);
	const onWriteStart = useCallback(() => {
		setLastSend(null);
		setLastMint(null);
	}, []);
	// Kept here, not only in the dialog: the re-read after a mint can unmount it.
	const onMinted = useCallback(
		(message: string) => setLastMint({ ok: true, message }),
		[],
	);
	const onMintFailed = useCallback(
		(message: string) => setLastMint({ ok: false, message }),
		[],
	);
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
				<LastMintNotice lastMint={lastMint} className="mt-3" />
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
				<LastMintNotice lastMint={lastMint} className="mt-3" />
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
		<TokenDetailLayout
			actions={
				<OneColorActions
					token={token}
					onWriteStart={onWriteStart}
					onSendOutcome={onSendOutcome}
					onMinted={onMinted}
					onMintFailed={onMintFailed}
				/>
			}
			badge={<OneColorAuthorityChip authorities={token.authorities} />}
			balance={formatBsv21Amount(token.available, token.dec)}
			balanceCaption={
				token.pending > 0n
					? `${formatBsv21Amount(token.pending, token.dec)} waiting to be claimed`
					: "Available"
			}
			details={
				<>
					<DetailRow label="Decimals">{token.dec}</DetailRow>
					<DetailRow label="Mint authorities">{token.authorities}</DetailRow>
					<DetailRow label="Overlay" stack>
						{overlayText}
					</DetailRow>
				</>
			}
			icon={token.icon}
			id={assetId}
			idLabel="Asset ID"
			status={
				<>
					<LastMintNotice lastMint={lastMint} />
					{lastSend ? (
						<p
							className={`text-sm wrap-anywhere ${lastSend.kind === "sent" ? "text-primary" : "text-destructive"}`}
							role={lastSend.kind === "sent" ? "status" : "alert"}
						>
							{lastSend.message}
						</p>
					) : null}
				</>
			}
			ticker={ticker}
		>
			<OneColorPendingSends
				token={token}
				undelivered={undelivered}
				onCancelOutcome={onCancelOutcome}
			/>
			<section
				aria-labelledby="one-color-history"
				className="flex flex-col gap-3"
			>
				<SectionHeader
					action={
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
					}
					title={<span id="one-color-history">History</span>}
				/>
				<OneColorHistory assetId={assetId} dec={token.dec} />
			</section>
		</TokenDetailLayout>
	);
}

/**
 * What the page shows before it can read the built-in wallet. A chain
 * without 1Color never shows the page: it goes to Tokens (the proxy sends
 * mainnet there before render; this covers a chain switched in the tab).
 */
function OneColorDetailGate({ children }: { children: ReactNode }) {
	const access = useOneColorAccess();
	const router = useRouter();
	useEffect(() => {
		if (access === "unavailable") router.replace("/wallet/tokens");
	}, [access, router]);

	if (access === "loading" || access === "unavailable") {
		return <OneColorLoading label="Loading wallet…" />;
	}
	if (access === "locked") {
		return (
			<EmptyState icon={Coins} title="Unlock your wallet to see this token" />
		);
	}
	if (access === "external") return <OneColorExternalWallet />;
	return children;
}

/**
 * One 1Color token (testnet only): balance, Receive, Send and Mint, sends
 * waiting to be claimed, history and the token's facts. The wallet header
 * is the page's h1 and back arrow to Tokens.
 */
export default function OneColorDetail({ assetId }: { assetId: string }) {
	return (
		<OneColorDetailGate>
			<OneColorDetailBody assetId={assetId} />
		</OneColorDetailGate>
	);
}
