import { OrdinalThumb } from "@/components/wallet/migration-ordinal-card";
import { cn } from "@/lib/utils";
import type { SweepThumb } from "@/lib/wallet/sweep-summary";

/**
 * A compact row of ordinal thumbnails, at most `max`, then a "+N" tile for
 * the rest. Few tiles on purpose: SVG and HTML ordinals load in frames.
 */
export function SweepThumbStrip({
	items,
	total,
	max = 5,
	className,
}: {
	items: SweepThumb[];
	total: number;
	max?: number;
	className?: string;
}) {
	const shown = items.slice(0, max);
	const more = Math.max(0, total - shown.length);
	return (
		<ul
			data-slot="sweep-thumb-strip"
			aria-label={`${total} ${total === 1 ? "ordinal" : "ordinals"}`}
			className={cn("flex min-w-0 items-center gap-1.5", className)}
		>
			{shown.map((item) => (
				<li key={item.key} className="size-10 shrink-0">
					<OrdinalThumb
						contentUrl={item.contentUrl}
						contentType={item.contentType}
						title={item.name || "Ordinal"}
						className="rounded-md border"
					/>
				</li>
			))}
			{more > 0 && (
				<li className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted font-medium text-muted-foreground text-xs tabular-nums">
					+{more}
				</li>
			)}
		</ul>
	);
}
