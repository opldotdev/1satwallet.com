"use client";

import { listOpns, type WalletOutput } from "@1sat/actions";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, RefreshCw, Search, Send, Wallet } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	OpnsActionDialog,
	type OpnsActionKind,
} from "@/components/opns/opns-action-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { SectionHeader } from "@/components/ui/section-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useStackFeatures } from "@/lib/hooks/use-stack-features";
import {
	isOpnsListed,
	isOpnsPublished,
	opnsAssetId,
	ownedOpnsName,
} from "@/lib/opns";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import {
	getDisplayOutpoint,
	shortOutpoint,
} from "@/lib/wallet/wallet-output-utils";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

const PAGE_SIZE = 50;

/** Rows of the same shape as the list, while it loads. */
function OwnedOpnsSkeleton() {
	return (
		<div role="status" className="flex flex-col gap-3">
			<div className="flex items-center justify-between gap-4">
				<Skeleton className="h-6 w-24" />
				<Skeleton className="size-9 max-md:size-11" />
			</div>
			<div className="flex flex-col divide-y divide-border/60">
				{["one", "two", "three"].map((id) => (
					<div key={id} className="flex flex-col gap-3 py-3">
						<div className="flex items-center justify-between gap-3">
							<Skeleton className="h-4 w-36" />
							<Skeleton className="h-5 w-20 rounded-full" />
						</div>
						<Skeleton className="h-3 w-24" />
					</div>
				))}
			</div>
			<span className="sr-only">Loading your OpNS names</span>
		</div>
	);
}

/**
 * The OpNS names in the wallet. Each row carries its own actions (OpNS has
 * no wallet detail page): Send and Publish while it is free, Cancel listing
 * while it is listed.
 */
export function OwnedOpns() {
	const router = useRouter();
	const queryClient = useQueryClient();
	const stackFeatures = useStackFeatures();
	const {
		oneSatContext,
		identityKey,
		isInitialized,
		isInitializing,
		refreshBalance,
	} = useWalletToolbox();
	const [offset, setOffset] = useState(0);
	const [action, setAction] = useState<{
		kind: OpnsActionKind;
		output: WalletOutput;
	} | null>(null);
	const identityRef = useRef(identityKey);

	useEffect(() => {
		if (identityRef.current === identityKey) return;
		identityRef.current = identityKey;
		setOffset(0);
		setAction(null);
	}, [identityKey]);

	const namesQuery = useQuery({
		queryKey: ["opns-names", identityKey, offset],
		queryFn: async () => {
			if (!oneSatContext) return { outputs: [], totalOutputs: 0 };
			return listOpns.execute(oneSatContext, {
				limit: PAGE_SIZE,
				offset,
				includeTags: true,
				includeCustomInstructions: true,
			});
		},
		enabled: isInitialized && !!oneSatContext,
		staleTime: 15_000,
	});

	// Logged once per failed load, after react-query's retries, not per try.
	const { error: namesError, errorUpdatedAt } = namesQuery;
	useEffect(() => {
		if (!namesError) return;
		reportDiagnostic({
			category: "action",
			code: "action.failed",
			operation: "wallet.opns.list",
			recoverable: true,
			context: { retryable: true },
		});
		console.error("[opns] listOpns failed", {
			offset,
			at: errorUpdatedAt,
			error: namesError,
		});
	}, [namesError, errorUpdatedAt, offset]);

	const refresh = useCallback(async () => {
		refreshBalance();
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: ["opns-names"] }),
			queryClient.invalidateQueries({ queryKey: ["wallet-balance"] }),
			queryClient.invalidateQueries({ queryKey: ["opns-listings"] }),
			queryClient.invalidateQueries({ queryKey: ["market-flow"] }),
		]);
		router.refresh();
	}, [queryClient, refreshBalance, router]);

	if (isInitializing || namesQuery.isLoading) {
		return <OwnedOpnsSkeleton />;
	}

	if (!isInitialized || !oneSatContext) {
		return (
			<EmptyState
				icon={Wallet}
				title="Wallet locked"
				description="Connect or unlock a wallet to see its OpNS names."
				action={
					<Button asChild variant="outline">
						<Link href="/wallet">Connect wallet</Link>
					</Button>
				}
			/>
		);
	}

	const names = namesQuery.data?.outputs ?? [];
	const total = namesQuery.data?.totalOutputs ?? names.length;
	const marketAvailable =
		stackFeatures.data?.capabilities.has("market") ?? false;
	const anyListed = names.some(isOpnsListed);

	return (
		<div className="flex flex-col gap-4">
			<SectionHeader
				title={
					namesQuery.data
						? `${total} name${total === 1 ? "" : "s"}`
						: "OpNS names"
				}
				action={
					<>
						<Button
							variant="ghost"
							size="icon"
							aria-label="Refresh names"
							disabled={namesQuery.isFetching}
							onClick={() => void refresh()}
						>
							<RefreshCw
								className={namesQuery.isFetching ? "animate-spin" : undefined}
							/>
						</Button>
						<Button asChild size="sm">
							<Link href="/opns">
								<Search data-icon="inline-start" />
								Find names
							</Link>
						</Button>
					</>
				}
			/>

			{anyListed && !marketAvailable && !stackFeatures.isPending && (
				<Notice tone="warning">
					The market is unavailable right now. You can still cancel a listing.
				</Notice>
			)}

			{namesQuery.isError ? (
				<Notice tone="danger" title="Couldn't load your OpNS names.">
					<Button
						variant="outline"
						size="sm"
						className="mt-2"
						onClick={() => void namesQuery.refetch()}
					>
						<RefreshCw data-icon="inline-start" />
						Retry
					</Button>
				</Notice>
			) : names.length === 0 ? (
				<EmptyState
					icon={AtSign}
					title="No names yet"
					description="OpNS names this wallet owns show up here."
				/>
			) : (
				<ul className="flex flex-col divide-y divide-border/60">
					{names.map((output) => {
						const id = opnsAssetId(output);
						const listed = isOpnsListed(output);
						const published = isOpnsPublished(output);
						const outpoint = getDisplayOutpoint(output);
						return (
							<li
								key={output.outpoint}
								data-slot="opns-row"
								className="flex flex-col gap-3 py-3"
							>
								<div className="flex flex-col gap-1">
									<div className="flex items-center justify-between gap-3">
										<span className="min-w-0 truncate font-medium">
											{ownedOpnsName(output)}
										</span>
										{(listed || published) && (
											<div className="flex shrink-0 gap-1">
												{published && (
													<Badge
														variant="outline"
														className="rounded-full px-2 font-medium"
													>
														Published
													</Badge>
												)}
												{listed && (
													<Badge
														variant="secondary"
														className="rounded-full px-2 font-medium"
													>
														Listed
													</Badge>
												)}
											</div>
										)}
									</div>
									<span
										className="font-mono text-xs text-muted-foreground"
										title={outpoint}
									>
										{shortOutpoint(outpoint)}
									</span>
								</div>
								{!id ? (
									<Notice tone="danger">
										This name is missing its asset ID, so it can't be changed.
										Refresh to try again.
									</Notice>
								) : listed ? (
									<div className="flex flex-wrap gap-2">
										<Button
											size="sm"
											variant="outline"
											onClick={() => setAction({ kind: "cancel", output })}
										>
											Cancel listing
										</Button>
									</div>
								) : (
									<div className="flex flex-wrap gap-2">
										<Button
											size="sm"
											variant="outline"
											onClick={() => setAction({ kind: "send", output })}
										>
											<Send data-icon="inline-start" />
											Send
										</Button>
										<Button
											size="sm"
											variant="outline"
											onClick={() =>
												setAction({
													kind: published ? "unpublish" : "publish",
													output,
												})
											}
										>
											{published ? "Unpublish" : "Publish profile"}
										</Button>
									</div>
								)}
							</li>
						);
					})}
				</ul>
			)}

			{total > PAGE_SIZE && (
				<div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
					<span className="tabular-nums">
						{offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
					</span>
					<div className="flex gap-2">
						<Button
							variant="outline"
							size="sm"
							disabled={offset === 0}
							onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
						>
							Previous
						</Button>
						<Button
							variant="outline"
							size="sm"
							disabled={offset + PAGE_SIZE >= total}
							onClick={() => setOffset(offset + PAGE_SIZE)}
						>
							Next
						</Button>
					</div>
				</div>
			)}

			{action && (
				<OpnsActionDialog
					kind={action.kind}
					output={action.output}
					open
					onOpenChange={(open) => {
						if (!open) setAction(null);
					}}
					onSuccess={refresh}
				/>
			)}
		</div>
	);
}
