import { Progress } from "@/components/ui/progress";

/** The sweep in flight: one bar and one line, never a log. */
export function SweepStepLine({
	line,
	percent,
}: {
	line: string;
	percent: number;
}) {
	return (
		<div data-slot="sweep-step-line" className="flex flex-col gap-3">
			<Progress value={percent} aria-label="Sweep progress" />
			<div className="flex items-baseline justify-between gap-3 text-sm">
				<p aria-live="polite" className="min-w-0 truncate">
					{line}
				</p>
				<span className="shrink-0 text-muted-foreground tabular-nums">
					{Math.round(percent)}%
				</span>
			</div>
		</div>
	);
}
