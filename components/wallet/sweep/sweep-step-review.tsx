import { ChevronRight } from "lucide-react";
import type { ReviewLine, WizardStepId } from "@/lib/wallet/sweep-summary";
import { SweepRouteDiagram } from "./sweep-route-diagram";

/** Step: a short receipt of what moves; each line goes back to its step. */
export function SweepStepReview({
	lines,
	itemCount,
	notes,
	onJump,
}: {
	lines: ReviewLine[];
	/** Everything the sweep sends, as the footer counts it. */
	itemCount: number;
	/** Muted lines under the receipt: what stays, what else happens. */
	notes: string[];
	onJump: (step: WizardStepId) => void;
}) {
	return (
		<>
			<SweepRouteDiagram
				state={itemCount > 0 ? "idle" : "blocked"}
				payload={
					<p className="font-semibold text-xl tabular-nums">
						{itemCount.toLocaleString("en-US")}{" "}
						<span className="font-normal text-base text-muted-foreground">
							{itemCount === 1 ? "item" : "items"}
						</span>
					</p>
				}
			/>
			{lines.length > 0 && (
				<ul className="divide-y overflow-hidden rounded-xl border bg-card">
					{lines.map((line) => (
						<li key={line.label}>
							<button
								type="button"
								onClick={() => onJump(line.step)}
								className="flex min-h-12 w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
							>
								<span className="shrink-0 text-muted-foreground text-sm">
									{line.label}
								</span>
								<span className="min-w-0 flex-1 truncate text-right font-medium text-sm tabular-nums">
									{line.value}
								</span>
								<ChevronRight
									aria-hidden="true"
									className="size-4 shrink-0 text-muted-foreground"
								/>
							</button>
						</li>
					))}
				</ul>
			)}
			{notes.length > 0 && (
				<ul className="flex flex-col gap-1 px-1 text-muted-foreground text-xs">
					{notes.map((note) => (
						<li key={note}>{note}</li>
					))}
				</ul>
			)}
		</>
	);
}
