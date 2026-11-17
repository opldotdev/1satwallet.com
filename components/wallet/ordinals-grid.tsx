"use client";

import type { WalletOutput } from "@1sat/actions";
import { useQueryClient } from "@tanstack/react-query";
import {
	FileQuestion,
	FileText,
	Flame,
	Images,
	Plus,
	RefreshCw,
	Send,
	Wallet,
	X,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ArtifactModal, {
	type ArtifactModalItem,
} from "@/components/modal/artifact-modal";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
import {
	OrdinalActionDialog,
	type OrdinalActionKind,
} from "@/components/wallet/ordinal-action-dialog";
import { OrdinalsGridSkeleton } from "@/components/wallet/ordinals-grid-skeleton";
import { useOrdinalMetadata } from "@/hooks/use-ordinal-metadata";
import { isRouteAvailableOn } from "@/lib/chain-surfaces";
import { describeAssetSurface } from "@/lib/wallet/asset-query-state";
import { isOrdinalListed, ordinalAssetId } from "@/lib/wallet/ordinal-actions";
import { getOrdinalPresentation } from "@/lib/wallet/ordinal-presentation";
import {
	getDisplayOutpoint,
	shortOutpoint,
} from "@/lib/wallet/wallet-output-utils";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

export function OrdinalsGrid() {
	const router = useRouter();
	const queryClient = useQueryClient();
	const {
		ordinals,
		ordinalsState,
		isInitialized,
		isInitializing,
		isBalanceLoading,
		identityKey,
		refreshBalance,
		chain,
	} = useWalletToolbox();
	const [selectedOutpoints, setSelectedOutpoints] = useState<Set<string>>(
		new Set(),
	);
	const [dialogKind, setDialogKind] = useState<OrdinalActionKind | null>(null);
	const [selectedArtifact, setSelectedArtifact] =
		useState<ArtifactModalItem | null>(null);
	const identityScopeRef = useRef(identityKey);
	const gridRef = useRef<HTMLElement>(null);
	const { metadataRequests, metadataQuery } = useOrdinalMetadata(
		ordinals,
		identityKey,
		isInitialized,
	);

	useEffect(() => {
		if (identityScopeRef.current === identityKey) return;
		identityScopeRef.current = identityKey;
		setSelectedOutpoints(new Set());
		setDialogKind(null);
		setSelectedArtifact(null);
	}, [identityKey]);

	const selectedOrdinals = useMemo(
		() => ordinals.filter((ordinal) => selectedOutpoints.has(ordinal.outpoint)),
		[ordinals, selectedOutpoints],
	);
	const selectionIsCurrent =
		selectedOrdinals.length === selectedOutpoints.size &&
		selectedOrdinals.every((ordinal) => ordinalAssetId(ordinal));
	const selectedListed = selectedOrdinals.filter(isOrdinalListed);
	const selectedUnlisted = selectedOrdinals.filter(
		(ordinal) => !isOrdinalListed(ordinal),
	);
	const onlyUnlisted =
		selectionIsCurrent &&
		selectedOrdinals.length > 0 &&
		selectedUnlisted.length === selectedOrdinals.length;
	const oneListed =
		selectionIsCurrent &&
		selectedOrdinals.length === 1 &&
		selectedListed.length === 1;

	const toggleSelection = useCallback((outpoint: string) => {
		setSelectedOutpoints((previous) => {
			const next = new Set(previous);
			if (next.has(outpoint)) next.delete(outpoint);
			else next.add(outpoint);
			return next;
		});
	}, []);

	// The Clear button leaves with the bar, so focus goes back to the grid.
	const clearSelection = useCallback(() => {
		setSelectedOutpoints(new Set());
		gridRef.current?.focus();
	}, []);

	const refresh = useCallback(async () => {
		refreshBalance();
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: ["wallet-balance"] }),
			queryClient.invalidateQueries({ queryKey: ["market-flow"] }),
		]);
		router.refresh();
	}, [queryClient, refreshBalance, router]);

	const actionSucceeded = useCallback(async () => {
		setSelectedOutpoints(new Set());
		await refresh();
	}, [refresh]);

	if (
		isInitializing ||
		isBalanceLoading ||
		(metadataRequests.length > 0 && metadataQuery.isPending)
	) {
		return <OrdinalsGridSkeleton />;
	}

	if (!isInitialized) {
		return (
			<EmptyState
				icon={Wallet}
				title="Wallet locked"
				description="Unlock or connect a wallet to see your ordinals."
			/>
		);
	}

	const counted =
		ordinalsState.kind === "ready" || ordinalsState.kind === "empty";
	// Only one kind of action applies to a selection; a mixed or stale one
	// says why instead of offering buttons that would be refused.
	let selectionNote: React.ReactNode = null;
	if (selectedOutpoints.size > 0 && !selectionIsCurrent) {
		selectionNote = (
			<p className="text-sm text-destructive" role="alert">
				The wallet changed since you selected these. Refresh and select them
				again; nothing was sent.
			</p>
		);
	} else if (selectedListed.length > 0 && selectedUnlisted.length > 0) {
		selectionNote = (
			<p className="text-sm text-muted-foreground">
				Listed and unlisted ordinals can't be sent together. Cancel the listing
				first.
			</p>
		);
	} else if (selectedListed.length > 1) {
		selectionNote = (
			<p className="text-sm text-muted-foreground">
				Cancel listings one at a time.
			</p>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<SectionHeader
				title={
					counted
						? `${ordinals.length} ordinal${ordinals.length === 1 ? "" : "s"}`
						: "Ordinals"
				}
				action={
					<>
						<Button
							variant="ghost"
							size="icon"
							aria-label="Refresh ordinals"
							onClick={() => void refresh()}
						>
							<RefreshCw />
						</Button>
						{isRouteAvailableOn(chain, "/inscribe") && (
							<Button asChild size="sm">
								<Link href="/inscribe">
									<Plus data-icon="inline-start" />
									Inscribe
								</Link>
							</Button>
						)}
					</>
				}
			/>

			{!counted ? (
				<EmptyState
					icon={Images}
					title={describeAssetSurface(ordinalsState, "inscription")}
					action={
						ordinalsState.kind === "error" ? (
							<Button variant="outline" onClick={() => void refresh()}>
								<RefreshCw data-icon="inline-start" />
								Try again
							</Button>
						) : undefined
					}
				/>
			) : ordinals.length === 0 ? (
				<EmptyState
					icon={Images}
					title="No ordinals yet"
					description="Inscriptions this wallet owns show up here."
				/>
			) : (
				<section
					ref={gridRef}
					aria-label="Your ordinals"
					tabIndex={-1}
					data-slot="ordinals-grid"
					className="grid outline-none grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
				>
					{ordinals.map((ordinal: WalletOutput) => {
						const outpoint = getDisplayOutpoint(ordinal);
						const metadata = metadataQuery.data?.[`${outpoint}:-2`];
						const presentation = getOrdinalPresentation(
							ordinal,
							metadata,
							chain,
						);
						const selected = selectedOutpoints.has(ordinal.outpoint);
						const actionable = !!ordinalAssetId(ordinal);
						return (
							<div
								key={ordinal.outpoint}
								data-slot="ordinal-tile"
								className={`group relative aspect-square overflow-hidden rounded-xl border bg-muted/50 transition-colors ${selected ? "border-primary ring-2 ring-primary/40" : "border-border/50 hover:border-primary/50"}`}
							>
								<button
									type="button"
									aria-label={`Open ${presentation.name}`}
									className="block size-full text-left"
									onClick={() =>
										setSelectedArtifact({
											outpoint,
											originOutpoint: presentation.originOutpoint,
											contentType: presentation.contentType,
											name: presentation.name,
											previewUrl: presentation.artworkUrl,
											externalUrl: presentation.href,
											chain,
										})
									}
								>
									{presentation.artworkUrl ? (
										<Image
											src={presentation.artworkUrl}
											alt={presentation.name}
											fill
											className="object-cover transition-transform group-hover:scale-105"
											sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 20vw"
											unoptimized
										/>
									) : (
										<div className="flex size-full flex-col items-center justify-center gap-2 p-4 text-center text-muted-foreground">
											{presentation.kind === "bitplan" ? (
												<FileText className="size-10" />
											) : (
												<FileQuestion className="size-10" />
											)}
											<span className="max-w-full truncate text-xs">
												{presentation.contentLabel}
											</span>
										</div>
									)}
									<div className="absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-transparent" />
									<div className="absolute inset-x-0 bottom-0 p-2 text-xs text-white">
										<div className="truncate font-medium">
											{presentation.name}
										</div>
										<div
											className="truncate font-mono text-white/70"
											title={outpoint}
										>
											{shortOutpoint(outpoint)}
										</div>
									</div>
								</button>
								{/* A 44px tap target in the corner around a 20px box. */}
								<label className="absolute top-0 left-0 flex size-11 cursor-pointer items-center justify-center has-disabled:cursor-not-allowed">
									<span className="flex size-7 items-center justify-center rounded-md bg-background/90 shadow-sm">
										<input
											type="checkbox"
											className="size-5 accent-primary"
											checked={selected}
											disabled={!actionable}
											onChange={() => toggleSelection(ordinal.outpoint)}
										/>
									</span>
									<span className="sr-only">Select {presentation.name}</span>
								</label>
								{!actionable ? (
									<span className="absolute top-2 right-2 rounded-full bg-destructive px-2 py-0.5 text-xs font-medium text-destructive-foreground">
										Refresh required
									</span>
								) : (
									isOrdinalListed(ordinal) && (
										<span className="absolute top-2 right-2 rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
											Listed
										</span>
									)
								)}
							</div>
						);
					})}
				</section>
			)}

			{selectedOutpoints.size > 0 && (
				// Room under the grid so the fixed bar never covers the last row.
				<div
					aria-hidden="true"
					className="h-[calc(--spacing(16)+env(safe-area-inset-bottom))] md:hidden"
				/>
			)}

			{selectedOutpoints.size > 0 && (
				// Shown only while something is selected. On phones it is fixed to
				// the bottom of the screen, edge to edge and clear of the home
				// indicator, however short the grid; from md it floats as a card
				// over the bottom of the grid.
				<section
					aria-label="Selected ordinals"
					data-slot="selection-bar"
					className="fixed inset-x-0 bottom-0 z-30 flex flex-col gap-2 border-t bg-background/95 pt-3 pr-[max(var(--page-x),env(safe-area-inset-right))] pb-[max(--spacing(3),env(safe-area-inset-bottom))] pl-[max(var(--page-x),env(safe-area-inset-left))] backdrop-blur supports-backdrop-filter:bg-background/80 md:sticky md:inset-x-auto md:bottom-4 md:rounded-xl md:border md:px-(--page-x) md:pb-3 md:shadow-lg"
				>
					<div className="flex items-center gap-2">
						<Button
							variant="ghost"
							size="icon"
							aria-label="Clear selection"
							className="-ml-2"
							onClick={clearSelection}
						>
							<X />
						</Button>
						<span
							aria-live="polite"
							className="flex-1 text-sm font-medium tabular-nums"
						>
							{selectedOutpoints.size} selected
						</span>
						{onlyUnlisted && (
							<>
								<Button variant="outline" onClick={() => setDialogKind("send")}>
									<Send data-icon="inline-start" />
									Send
								</Button>
								<Button
									variant="destructive"
									onClick={() => setDialogKind("burn")}
								>
									<Flame data-icon="inline-start" />
									Burn
								</Button>
							</>
						)}
						{oneListed && (
							<Button variant="outline" onClick={() => setDialogKind("cancel")}>
								<X data-icon="inline-start" />
								Cancel listing
							</Button>
						)}
					</div>
					{selectionNote}
				</section>
			)}

			{dialogKind && (
				<OrdinalActionDialog
					kind={dialogKind}
					ordinals={selectedOrdinals}
					open
					onOpenChange={(open) => {
						if (!open) setDialogKind(null);
					}}
					onSuccess={actionSucceeded}
				/>
			)}

			<ArtifactModal
				artifact={selectedArtifact}
				onClose={() => setSelectedArtifact(null)}
			/>
		</div>
	);
}
