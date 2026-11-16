"use client";

import { Loader2 } from "lucide-react";
import Image from "next/image";
import { type ReactNode, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useOrdinalMetadata } from "@/hooks/use-ordinal-metadata";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import { describeAssetSurface } from "@/lib/wallet/asset-query-state";
import { ordinalImageReference } from "@/lib/wallet/bap-identity";
import { getOrdinalPresentation } from "@/lib/wallet/ordinal-presentation";
import { getDisplayOutpoint } from "@/lib/wallet/wallet-output-utils";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

/**
 * The wallet's image ordinals. Picking one hands back `1sat://txid.vout` for
 * its origin, the reference the iOS app and Yours write for a BAP image.
 */
export function ProfileImagePicker({
	open,
	onOpenChange,
	title,
	onSelect,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	onSelect: (reference: string) => void;
}) {
	const { ordinals, ordinalsState, identityKey, isBalanceLoading, chain } =
		useWalletToolbox();
	const { metadataQuery } = useOrdinalMetadata(ordinals, identityKey, open);
	const images = useMemo(() => {
		const seen = new Set<string>();
		return ordinals.flatMap((ordinal) => {
			const metadata =
				metadataQuery.data?.[`${getDisplayOutpoint(ordinal)}:-2`];
			const presentation = getOrdinalPresentation(ordinal, metadata, chain);
			const { artworkUrl, kind, name } = presentation;
			const reference = ordinalImageReference(presentation.originOutpoint);
			if (
				kind !== "image" ||
				!artworkUrl ||
				!reference ||
				seen.has(reference)
			) {
				return [];
			}
			seen.add(reference);
			return [{ artworkUrl, name, reference }];
		});
	}, [ordinals, metadataQuery.data, chain]);

	useEffect(() => {
		if (!metadataQuery.isError) return;
		reportDiagnostic({
			category: "provider",
			code: "provider.failed",
			operation: "bap-profile.image-picker.ordinal-metadata",
			recoverable: true,
			context: { retryable: true },
		});
	}, [metadataQuery.isError]);

	let body: ReactNode;
	if (isBalanceLoading || (ordinals.length > 0 && metadataQuery.isPending)) {
		body = (
			<p
				aria-live="polite"
				className="flex items-center gap-2 text-muted-foreground text-sm"
				role="status"
			>
				<Loader2 className="h-4 w-4 animate-spin" /> Reading wallet ordinals…
			</p>
		);
	} else if (metadataQuery.isError) {
		body = (
			<div className="space-y-3" role="alert">
				<p className="text-destructive text-sm">
					Wallet ordinal details could not be read.
				</p>
				<Button
					onClick={() => void metadataQuery.refetch()}
					size="sm"
					type="button"
					variant="outline"
				>
					Retry
				</Button>
			</div>
		);
	} else if (ordinalsState.kind !== "ready" && ordinalsState.kind !== "empty") {
		body = (
			<p className="text-muted-foreground text-sm" role="status">
				{describeAssetSurface(ordinalsState, "inscription")}
			</p>
		);
	} else if (images.length === 0) {
		body = (
			<p className="text-muted-foreground text-sm" role="status">
				No image ordinals in this wallet.
			</p>
		);
	} else {
		body = (
			<div className="grid max-h-96 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
				{images.map((image) => (
					<button
						aria-label={`Use ${image.name}`}
						className="group relative aspect-square overflow-hidden rounded-md border border-border/50 bg-muted/50 hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						key={image.reference}
						onClick={() => {
							onSelect(image.reference);
							onOpenChange(false);
						}}
						title={image.name}
						type="button"
					>
						<Image
							alt=""
							className="object-cover"
							fill
							sizes="(max-width: 640px) 33vw, 8rem"
							src={image.artworkUrl}
							unoptimized
						/>
						<span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/75 to-transparent p-1 text-left text-white text-xs">
							{image.name}
						</span>
					</button>
				))}
			</div>
		);
	}

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>
						Image ordinals held by the active wallet. The profile stores the
						ordinal as a 1sat:// reference.
					</DialogDescription>
				</DialogHeader>
				{body}
				<DialogFooter>
					<Button onClick={() => onOpenChange(false)} variant="outline">
						Cancel
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
