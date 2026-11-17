import { cn } from "@/lib/utils";

/** "Step 2 of 4" and a segmented bar that fills as the steps go by. */
export function SweepStepIndicator({
	index,
	total,
	className,
}: {
	index: number;
	total: number;
	className?: string;
}) {
	return (
		<div
			data-slot="sweep-step-indicator"
			className={cn("flex min-w-0 flex-1 items-center gap-3", className)}
		>
			<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
				Step {index + 1} of {total}
			</span>
			<div className="flex flex-1 gap-1" aria-hidden="true">
				{Array.from({ length: total }, (_, i) => (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed segments
						key={i}
						className="h-1 flex-1 overflow-hidden rounded-full bg-muted"
					>
						<span
							className={cn(
								"block h-full rounded-full bg-primary motion-safe:transition-[width] motion-safe:duration-300 motion-safe:ease-out",
								i <= index ? "w-full" : "w-0",
							)}
						/>
					</span>
				))}
			</div>
		</div>
	);
}
