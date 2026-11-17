import type { SweepSummary } from "@/lib/wallet/sweep-summary";
import { SweepRouteDiagram } from "./sweep-route-diagram";
import { SweepToggleRow } from "./sweep-toggle-row";

/** Step: the BSV, as one big amount travelling into this wallet. */
export function SweepStepBsv({
	bsv,
	included,
	onIncludedChange,
}: {
	bsv: NonNullable<SweepSummary["bsv"]>;
	included: boolean;
	onIncludedChange: (included: boolean) => void;
}) {
	return (
		<>
			<SweepRouteDiagram
				state={included ? "idle" : "blocked"}
				payload={
					<>
						<p className="font-mono font-semibold text-3xl tabular-nums tracking-tight">
							{bsv.bsv}
							<span className="ml-1.5 font-sans font-medium text-base text-muted-foreground">
								BSV
							</span>
						</p>
						<p className="text-muted-foreground text-xs tabular-nums">
							{bsv.satsLabel}
						</p>
					</>
				}
			/>
			<SweepToggleRow
				label="Include BSV"
				hint={
					included ? "Moves with this sweep" : "Stays at your old addresses"
				}
				checked={included}
				onCheckedChange={onIncludedChange}
			/>
		</>
	);
}
