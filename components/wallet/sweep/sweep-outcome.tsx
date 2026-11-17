import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";
import { PAY_SUCCESS_SVG } from "@/components/wallet/pay-success-mark";
import type {
	SweepOutcome as Outcome,
	OutcomeRow,
} from "@/lib/wallet/sweep-summary";
import { SweepRouteDiagram } from "./sweep-route-diagram";

function RowIcon({ status }: { status: OutcomeRow["status"] }) {
	if (status === "done")
		return (
			<CircleCheck
				aria-hidden="true"
				className="size-4 shrink-0 text-success"
			/>
		);
	if (status === "partial")
		return (
			<TriangleAlert
				aria-hidden="true"
				className="size-4 shrink-0 text-warning"
			/>
		);
	return (
		<CircleX aria-hidden="true" className="size-4 shrink-0 text-destructive" />
	);
}

/**
 * The finished sweep: a success mark when everything moved, otherwise the
 * route; one row per kind with its outcome, then plain reasons and what is
 * still at the old addresses. No transaction ids here (Details has them).
 */
export function SweepOutcome({
	outcome,
	stayLines = [],
}: {
	outcome: Outcome;
	/** Lines about what stays put (time-locked, BSV-20 inscriptions...). */
	stayLines?: string[];
}) {
	const success = outcome.kind === "all-moved";
	return (
		<>
			{success ? (
				<div
					className="mx-auto size-36 [&>svg]:size-full"
					// A bundled constant, never transaction or user input.
					dangerouslySetInnerHTML={{ __html: PAY_SUCCESS_SVG }}
				/>
			) : outcome.kind === "nothing" ? null : (
				<SweepRouteDiagram
					state={outcome.kind === "failed" ? "blocked" : "done"}
				/>
			)}
			{outcome.rows.length > 0 && (
				<ul className="divide-y overflow-hidden rounded-xl border bg-card">
					{outcome.rows.map((row) => (
						<li
							key={row.key}
							className="flex min-h-12 items-center gap-3 px-4 py-3"
						>
							<RowIcon status={row.status} />
							<span className="min-w-0 flex-1 truncate font-medium text-sm">
								{row.label}
							</span>
							<span className="shrink-0 text-muted-foreground text-sm">
								{row.note}
							</span>
						</li>
					))}
				</ul>
			)}
			{(outcome.notes.length > 0 ||
				outcome.remaining > 0 ||
				stayLines.length > 0) && (
				<ul className="flex flex-col gap-1.5 px-1 text-muted-foreground text-sm">
					{outcome.notes.map((note) => (
						<li key={note}>{note}</li>
					))}
					{outcome.remaining > 0 && (
						<li>
							{outcome.remaining.toLocaleString("en-US")}{" "}
							{outcome.remaining === 1 ? "item is" : "items are"} still at your
							old addresses.
						</li>
					)}
					{stayLines.map((line) => (
						<li key={line}>{line}</li>
					))}
				</ul>
			)}
		</>
	);
}
