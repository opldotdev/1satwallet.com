import { Button } from "@/components/ui/button";
import type { SweepSummary } from "@/lib/wallet/sweep-summary";
import { SweepRouteDiagram } from "./sweep-route-diagram";
import { SweepThumbStrip } from "./sweep-thumb-strip";
import { SweepToggleRow } from "./sweep-toggle-row";

/** Step: ordinals and names, selected by default, previewed as a short strip. */
export function SweepStepCollectibles({
	ordinals,
	names,
	selectedCount,
	included,
	onIncludedChange,
	onReview,
}: {
	ordinals: SweepSummary["ordinals"];
	names: SweepSummary["names"];
	selectedCount: number;
	included: boolean;
	onIncludedChange: (included: boolean) => void;
	onReview: () => void;
}) {
	const nameLine =
		names.count > 0
			? `${names.preview.join(", ")}${names.more > 0 ? ` +${names.more}` : ""}`
			: null;
	return (
		<>
			<SweepRouteDiagram
				state={included ? "idle" : "blocked"}
				payload={
					<>
						{ordinals.count > 0 && (
							<SweepThumbStrip items={ordinals.thumbs} total={ordinals.count} />
						)}
						{nameLine && (
							<p className="max-w-full truncate text-muted-foreground text-xs">
								{nameLine}
							</p>
						)}
					</>
				}
			/>
			<SweepToggleRow
				label="Include ordinals & names"
				hint={
					included
						? ordinals.count > 0
							? `${selectedCount} of ${ordinals.count} ordinals selected`
							: "Moves with this sweep"
						: "Stay at your old addresses"
				}
				checked={included}
				onCheckedChange={onIncludedChange}
			/>
			{ordinals.count > 0 && included && (
				<Button
					type="button"
					variant="outline"
					className="w-full"
					onClick={onReview}
				>
					Choose ordinals
				</Button>
			)}
		</>
	);
}
