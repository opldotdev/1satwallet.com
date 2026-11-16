"use client";

import { History, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { SectionHeader } from "@/components/ui/section-header";
import { Skeleton } from "@/components/ui/skeleton";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import {
	ACTION_HISTORY_PAGE_SIZE,
	type ActionHistoryState,
	actionAmountLabel,
	actionBlockTimes,
	actionExplorerUrl,
	actionHistoryForIdentity,
	actionStatusLabel,
	actionTimeLabel,
	listActionHistoryPage,
	orderActionsNewestFirst,
} from "@/lib/wallet/action-history";
import { shortTxid } from "@/lib/wallet/wallet-output-utils";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

const NO_BLOCK_TIMES: ReadonlyMap<string, number> = new Map();

const LOAD_FAILED = "Couldn't load your transaction history.";

/** Rows of the same shape as the list, while it loads. */
function HistorySkeleton() {
	return (
		<div role="status" className="flex flex-col divide-y divide-border/60">
			{["one", "two", "three", "four", "five"].map((id) => (
				<div key={id} className="flex min-h-14 flex-col gap-2 py-3">
					<div className="flex items-center justify-between gap-3">
						<Skeleton className="h-4 w-40" />
						<Skeleton className="h-4 w-28" />
					</div>
					<Skeleton className="h-3 w-48" />
				</div>
			))}
			<span className="sr-only">Loading transaction history</span>
		</div>
	);
}

/**
 * The wallet's transactions, newest first. A row reads: what it was and the
 * amount; then when, the short txid (a link to the explorer) and, unless it
 * is mined, one status badge.
 */
const HistoryList = () => {
	const { chain, identityKey, isInitialized, services, wallet } =
		useWalletToolbox();
	const [history, setHistory] = useState<ActionHistoryState>({
		identityKey: null,
		actions: null,
		totalActions: 0,
		error: null,
	});
	const [pagination, setPagination] = useState({ identityKey, page: 0 });
	const [refreshRevision, setRefreshRevision] = useState(0);
	const [blockTimes, setBlockTimes] = useState<{
		actions: ActionHistoryState["actions"];
		times: ReadonlyMap<string, number>;
	}>({ actions: null, times: NO_BLOCK_TIMES });
	const requestSequence = useRef(0);
	const requestId = useRef("");
	const page = pagination.identityKey === identityKey ? pagination.page : 0;
	const currentHistory = actionHistoryForIdentity(history, identityKey);
	const { actions, error, totalActions } = currentHistory;

	useEffect(() => {
		const currentRequest = `${identityKey}:${page}:${refreshRevision}:${++requestSequence.current}`;
		requestId.current = currentRequest;

		if (!wallet || !isInitialized) {
			setHistory({ identityKey, actions: null, totalActions: 0, error: null });
			return;
		}

		setHistory({ identityKey, actions: null, totalActions: 0, error: null });
		void listActionHistoryPage(wallet, page).then(
			(result) => {
				if (requestId.current !== currentRequest) return;
				setHistory({
					identityKey,
					actions: result.actions,
					totalActions: result.totalActions,
					error: null,
				});
			},
			(reason: unknown) => {
				if (requestId.current !== currentRequest) return;
				// The full error goes to the log; the page shows a short message.
				reportDiagnostic({
					category: "action",
					code: "action.failed",
					operation: "wallet.history.list",
					recoverable: true,
					context: { retryable: true },
				});
				console.error("[history] listActions failed", { page, reason });
				setHistory({
					identityKey,
					actions: [],
					totalActions: 0,
					error: LOAD_FAILED,
				});
			},
		);

		return () => {
			requestId.current = "cancelled";
		};
	}, [identityKey, isInitialized, page, refreshRevision, wallet]);

	useEffect(() => {
		if (!services || !actions?.length) return;
		let cancelled = false;
		void actionBlockTimes(services, actions).then((times) => {
			if (!cancelled) setBlockTimes({ actions, times });
		});
		return () => {
			cancelled = true;
		};
	}, [actions, services]);

	const times =
		blockTimes.actions === actions ? blockTimes.times : NO_BLOCK_TIMES;
	const orderedActions = useMemo(
		() => (actions ? orderActionsNewestFirst(actions, times) : null),
		[actions, times],
	);

	const refresh = () => setRefreshRevision((revision) => revision + 1);
	const loading = !!wallet && !error && (!isInitialized || actions === null);

	let body: React.ReactNode;
	if (!wallet) {
		body = (
			<EmptyState
				icon={History}
				title="Wallet locked"
				description="Unlock your wallet to see its transactions."
			/>
		);
	} else if (error) {
		body = (
			<Notice tone="danger" title={error}>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="mt-2"
					onClick={refresh}
				>
					<RefreshCw data-icon="inline-start" /> Retry
				</Button>
			</Notice>
		);
	} else if (loading || !actions) {
		body = <HistorySkeleton />;
	} else if (actions.length === 0) {
		body = (
			<EmptyState
				icon={History}
				title={page === 0 ? "No transactions yet" : "Nothing on this page"}
				description={
					page === 0
						? "Payments this wallet sends or receives show up here."
						: undefined
				}
				action={
					page > 0 ? (
						<Button
							type="button"
							variant="outline"
							onClick={() => setPagination({ identityKey, page: page - 1 })}
						>
							Previous page
						</Button>
					) : undefined
				}
			/>
		);
	} else {
		const firstAction = page * ACTION_HISTORY_PAGE_SIZE + 1;
		const lastAction = Math.min(firstAction + actions.length - 1, totalActions);
		body = (
			<>
				<ul className="flex flex-col divide-y divide-border/60">
					{(orderedActions ?? actions).map((action) => {
						const explorerUrl = actionExplorerUrl(action.txid, chain);
						const time = times.get(action.txid);
						// With no block time yet, the status badge stands in for it.
						const timeLabel =
							time === undefined ? undefined : actionTimeLabel(action, time);
						const status = actionStatusLabel(action);
						const description =
							action.description.trim() ||
							(action.satoshis < 0
								? "Sent"
								: action.satoshis > 0
									? "Received"
									: "Transaction");
						const txid = shortTxid(action.txid);
						return (
							<li
								key={action.txid}
								data-slot="history-row"
								className="flex min-h-14 flex-col justify-center gap-1 py-3"
							>
								<div className="flex items-baseline justify-between gap-3">
									<span className="min-w-0 truncate text-sm font-medium">
										{description}
									</span>
									<span
										className={`shrink-0 font-mono text-sm tabular-nums ${action.satoshis > 0 ? "text-primary" : "text-muted-foreground"}`}
									>
										{actionAmountLabel(action.satoshis)}
									</span>
								</div>
								<div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
									{time !== undefined && timeLabel && (
										<>
											<time
												className="min-w-0 truncate"
												dateTime={new Date(time).toISOString()}
												title={new Date(time).toLocaleString()}
											>
												{timeLabel}
											</time>
											<span aria-hidden="true">·</span>
										</>
									)}
									{explorerUrl ? (
										<a
											href={explorerUrl}
											target="_blank"
											rel="noreferrer"
											aria-label={`Transaction ${txid} on WhatsOnChain`}
											title={action.txid}
											className="shrink-0 font-mono underline-offset-4 hover:text-primary hover:underline"
										>
											{txid}
										</a>
									) : (
										<span className="shrink-0 font-mono" title={action.txid}>
											{txid}
										</span>
									)}
									{status && (
										<Badge
											variant={
												action.status === "failed" ? "destructive" : "outline"
											}
											className="ml-auto shrink-0 rounded-full px-2 font-medium"
										>
											{status}
										</Badge>
									)}
								</div>
							</li>
						);
					})}
				</ul>
				<div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
					<span className="tabular-nums">
						{firstAction}–{lastAction} of {totalActions}
					</span>
					<div className="flex gap-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={page === 0}
							onClick={() =>
								setPagination({ identityKey, page: Math.max(0, page - 1) })
							}
						>
							Previous
						</Button>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={lastAction >= totalActions}
							onClick={() => setPagination({ identityKey, page: page + 1 })}
						>
							Next
						</Button>
					</div>
				</div>
			</>
		);
	}

	return (
		<section
			aria-label="Transaction history"
			className="flex min-w-0 flex-col gap-3"
		>
			<SectionHeader
				title="Transaction history"
				action={
					wallet ? (
						<Button
							type="button"
							variant="ghost"
							size="icon"
							aria-label="Refresh history"
							disabled={loading}
							onClick={refresh}
						>
							<RefreshCw className={loading ? "animate-spin" : undefined} />
						</Button>
					) : undefined
				}
			/>
			{body}
		</section>
	);
};

export default HistoryList;
