"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { SweepOrdinal } from "@/lib/wallet/sweep-summary";

export interface MigrationOrdinalCardProps {
	ordinal: SweepOrdinal;
	isSelected: boolean;
	onToggle: () => void;
}

function isIframeType(contentType: string): boolean {
	return contentType === "image/svg+xml" || contentType.startsWith("text/html");
}

function isImageType(contentType: string): boolean {
	return contentType.startsWith("image/") && contentType !== "image/svg+xml";
}

/**
 * An ordinal's content in a square tile: an image, a sandboxed frame for SVG
 * and HTML, else a diamond. Lazy, so a long list loads as it scrolls.
 */
export function OrdinalThumb({
	contentUrl,
	contentType,
	title,
	className,
}: {
	contentUrl: string;
	contentType?: string;
	title: string;
	className?: string;
}) {
	const type = contentType || "";
	return (
		<div className={cn("aspect-square overflow-hidden bg-muted", className)}>
			{isIframeType(type) ? (
				<iframe
					src={contentUrl}
					title={title}
					className="pointer-events-none h-full w-full"
					sandbox=""
					loading="lazy"
				/>
			) : isImageType(type) ? (
				<img
					src={contentUrl}
					alt={title}
					className="h-full w-full object-cover"
					loading="lazy"
				/>
			) : (
				<div className="flex h-full w-full items-center justify-center text-muted-foreground">
					&#9670;
				</div>
			)}
		</div>
	);
}

export function MigrationOrdinalCard({
	ordinal,
	isSelected,
	onToggle,
}: MigrationOrdinalCardProps) {
	const contentType = ordinal.contentType || "";

	return (
		<button
			type="button"
			className={cn(
				"relative aspect-square w-full cursor-pointer overflow-hidden rounded-lg border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				isSelected
					? "border-primary ring-2 ring-primary"
					: "border-border hover:border-primary/40",
			)}
			onClick={onToggle}
			aria-pressed={isSelected}
		>
			{/* Selection checkbox */}
			<div className="absolute top-1.5 right-1.5 z-10">
				<div
					className={cn(
						"flex h-5 w-5 items-center justify-center rounded border text-[11px]",
						isSelected
							? "bg-primary border-primary text-primary-foreground"
							: "border-muted-foreground/40",
					)}
				>
					{isSelected && <span>&#10003;</span>}
				</div>
			</div>

			{/* Thumbnail */}
			<OrdinalThumb
				contentUrl={ordinal.contentUrl}
				contentType={contentType}
				title={ordinal.name || ordinal.outpoint}
			/>

			{/* Footer info */}
			<div className="absolute bottom-0 left-0 right-0 space-y-0.5 bg-background/80 p-1.5">
				<Badge variant="secondary" className="text-[10px]">
					{contentType?.split("/")[1] || "unknown"}
				</Badge>
				{ordinal.name && (
					<p className="truncate text-[11px] font-medium">{ordinal.name}</p>
				)}
			</div>
		</button>
	);
}
