import { Boxes, Hourglass, Lock, Tag, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { StayRow } from "@/lib/wallet/sweep-summary";
import { type Bsv20StaysData, SweepBsv20Stays } from "./sweep-bsv20-stays";
import { SweepRouteDiagram } from "./sweep-route-diagram";
import { SweepToggleRow } from "./sweep-toggle-row";

const ICONS: Record<Exclude<StayRow["kind"], "bsv20">, ReactNode> = {
	inactive: <TriangleAlert aria-hidden="true" className="size-5" />,
	locked: <Hourglass aria-hidden="true" className="size-5" />,
	run: <Boxes aria-hidden="true" className="size-5" />,
	listings: <Tag aria-hidden="true" className="size-5" />,
};

/**
 * Step: what stays at the old addresses and why, one row per reason, plus
 * open listings (cancelled first, or cancelled on their own).
 */
export function SweepStepStays({
	rows,
	bsv20,
	listingsIncluded,
	onListingsIncludedChange,
	onCancelListingsOnly,
	cancelListingsOnlyLabel,
}: {
	rows: StayRow[];
	bsv20: Bsv20StaysData;
	listingsIncluded: boolean;
	onListingsIncludedChange?: (included: boolean) => void;
	/** Omit when cancelling listings is the screen's primary action. */
	onCancelListingsOnly?: () => void;
	cancelListingsOnlyLabel: string;
}) {
	const stays = rows.filter((r) => r.kind !== "listings");
	const listings = rows.find((r) => r.kind === "listings");
	return (
		<>
			{stays.length > 0 && (
				<>
					<SweepRouteDiagram
						state="blocked"
						payload={
							<p className="flex items-center gap-1.5 text-muted-foreground text-xs">
								<Lock aria-hidden="true" className="size-3.5" />
								Stays at your old addresses
							</p>
						}
					/>
					<div className="divide-y overflow-hidden rounded-xl border bg-card">
						{stays.map((row) =>
							row.kind === "bsv20" ? (
								<SweepBsv20Stays key={row.key} data={bsv20} />
							) : (
								<div
									key={row.key}
									className="flex min-h-14 items-center gap-3 px-4 py-3"
								>
									<span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
										{ICONS[row.kind]}
									</span>
									<p className="min-w-0 flex-1 text-sm">{row.label}</p>
								</div>
							),
						)}
					</div>
				</>
			)}
			{listings && (
				<div className="flex flex-col gap-2">
					<div className="flex min-h-14 items-center gap-3 rounded-xl border bg-card px-4 py-3">
						<span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
							{ICONS.listings}
						</span>
						<p className="min-w-0 flex-1 text-sm">{listings.label}</p>
					</div>
					{onListingsIncludedChange && (
						<SweepToggleRow
							label="Cancel listings in this sweep"
							checked={listingsIncluded}
							onCheckedChange={onListingsIncludedChange}
						/>
					)}
					{onCancelListingsOnly && (
						<>
							<Button
								type="button"
								variant="outline"
								className="w-full"
								onClick={onCancelListingsOnly}
							>
								{cancelListingsOnlyLabel}
							</Button>
							<p className="text-center text-muted-foreground text-xs">
								Returns those ordinals to the wallet. It does not sweep BSV or
								tokens.
							</p>
						</>
					)}
				</div>
			)}
		</>
	);
}
