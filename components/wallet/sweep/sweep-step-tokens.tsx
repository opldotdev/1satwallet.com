"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { TokenIcon } from "@/components/wallet/token-row";
import { cn } from "@/lib/utils";
import type { SweepTokenLine } from "@/lib/wallet/sweep-summary";
import { SweepRouteDiagram } from "./sweep-route-diagram";
import { SweepToggleRow } from "./sweep-toggle-row";
import { SweepLetterAvatar, SweepTokenRow } from "./sweep-token-row";

const FIRST_ROWS = 5;

/** Step: every token with its ticker and full balance, inline. */
export function SweepStepTokens({
	tokens,
	includeBsv21,
	includeBsv20,
	onToggle,
}: {
	tokens: SweepTokenLine[];
	includeBsv21: boolean;
	includeBsv20: boolean;
	onToggle: (kind: "bsv21" | "bsv20", included: boolean) => void;
}) {
	const [showAll, setShowAll] = useState(false);
	const has21 = tokens.some((t) => t.kind === "bsv21");
	const has20 = tokens.some((t) => t.kind === "bsv20");
	const included = (t: SweepTokenLine) =>
		t.kind === "bsv21" ? includeBsv21 : includeBsv20;
	const anyIncluded = tokens.some(included);
	const shown = showAll ? tokens : tokens.slice(0, FIRST_ROWS);

	return (
		<>
			<SweepRouteDiagram
				state={anyIncluded ? "idle" : "blocked"}
				payload={
					<div className="flex items-center gap-2">
						<div className="flex -space-x-2">
							{tokens.slice(0, 3).map((t) =>
								t.kind === "bsv20" ? (
									<SweepLetterAvatar
										key={t.key}
										ticker={t.ticker}
										className="size-8 rounded-full border-2 border-card text-xs"
									/>
								) : (
									<span
										key={t.key}
										className="rounded-full border-2 border-card [&>div]:size-7 [&>div]:rounded-full"
									>
										<TokenIcon icon={t.icon} size={40} />
									</span>
								),
							)}
						</div>
						<span className="font-medium text-sm">
							{tokens.length} {tokens.length === 1 ? "token" : "tokens"}
						</span>
					</div>
				}
			/>
			<div className="overflow-hidden rounded-xl border bg-card">
				<div
					className={cn(
						"divide-y",
						showAll && "max-h-80 overflow-y-auto overscroll-contain",
					)}
				>
					{shown.map((t) => (
						<SweepTokenRow
							key={t.key}
							icon={t.icon}
							letterAvatar={t.kind === "bsv20"}
							ticker={t.ticker}
							amount={t.amount}
							outputCount={t.outputCount}
							dimmed={!included(t)}
						/>
					))}
				</div>
				{tokens.length > FIRST_ROWS && (
					<button
						type="button"
						className="flex min-h-11 w-full items-center justify-center gap-1 border-t text-muted-foreground text-sm hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
						aria-expanded={showAll}
						onClick={() => setShowAll((v) => !v)}
					>
						{showAll ? "Show fewer" : `Show all ${tokens.length}`}
						<ChevronDown
							aria-hidden="true"
							className={cn(
								"size-4 motion-safe:transition-transform",
								showAll && "rotate-180",
							)}
						/>
					</button>
				)}
			</div>
			{has21 && has20 ? (
				<div className="flex flex-col gap-2">
					<SweepToggleRow
						label="Include tokens"
						checked={includeBsv21}
						onCheckedChange={(v) => onToggle("bsv21", v)}
					/>
					<SweepToggleRow
						label="Include BSV-20 tokens"
						checked={includeBsv20}
						onCheckedChange={(v) => onToggle("bsv20", v)}
					/>
				</div>
			) : (
				<SweepToggleRow
					label="Include tokens"
					checked={has21 ? includeBsv21 : includeBsv20}
					onCheckedChange={(v) => onToggle(has21 ? "bsv21" : "bsv20", v)}
				/>
			)}
		</>
	);
}
