"use client";

import { ChevronDown, FileText, Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "@/lib/utils";
import type { Bsv20Group } from "@/lib/wallet/bsv20-content";
import { BSV20_STAYS_LINE } from "@/lib/wallet/sweep-summary";
import { SweepLetterAvatar } from "./sweep-token-row";

const TOP_TICKERS = 5;

export interface Bsv20StaysData {
	groups: Bsv20Group[];
	/** Every unconfirmed BSV-20 output. */
	total: number;
	/** How many have been read so far. */
	checked: number;
	loading: boolean;
}

/**
 * The BSV-20 inscriptions that stay put: one row with the count, opening to
 * one row per ticker (what each inscription says, unverified). Amounts are
 * never shown or summed here; Details lists what each one claims.
 */
export function SweepBsv20Stays({ data }: { data: Bsv20StaysData }) {
	const [open, setOpen] = useState(false);
	const listId = useId();
	const top = data.groups.slice(0, TOP_TICKERS);
	const moreTickers = data.groups.length - top.length;
	const unchecked = data.total - data.checked;

	return (
		<div data-slot="sweep-bsv20-stays">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={listId}
				onClick={() => setOpen((v) => !v)}
				className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
			>
				<span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
					<FileText aria-hidden="true" className="size-5" />
				</span>
				<span className="min-w-0 flex-1">
					<span className="block font-medium text-sm">
						BSV-20 inscriptions · {data.total.toLocaleString("en-US")}
					</span>
					<span className="block text-muted-foreground text-xs">
						{BSV20_STAYS_LINE}
					</span>
				</span>
				<ChevronDown
					aria-hidden="true"
					className={cn(
						"size-4 shrink-0 text-muted-foreground motion-safe:transition-transform",
						open && "rotate-180",
					)}
				/>
			</button>
			{open && (
				<div
					id={listId}
					className="flex flex-col gap-1 border-t bg-muted/30 px-4 py-3 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
				>
					{top.map((group) => (
						<div key={group.tick} className="flex min-h-10 items-center gap-3">
							<SweepLetterAvatar
								ticker={group.tick}
								className="size-8 text-xs"
							/>
							<span className="min-w-0 flex-1 truncate font-medium text-sm">
								{group.tick}
							</span>
							<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
								{group.outputs.toLocaleString("en-US")}{" "}
								{group.outputs === 1 ? "output" : "outputs"}
							</span>
						</div>
					))}
					{data.loading && (
						<p className="flex items-center gap-2 py-1 text-muted-foreground text-xs">
							<Loader2
								aria-hidden="true"
								className="size-3.5 motion-safe:animate-spin"
							/>
							Reading tickers…
						</p>
					)}
					{(moreTickers > 0 || (!data.loading && unchecked > 0)) && (
						<p className="pt-1 text-muted-foreground text-xs">
							{[
								moreTickers > 0 ? `+${moreTickers} more tickers` : null,
								!data.loading && unchecked > 0
									? `${unchecked.toLocaleString("en-US")} not checked`
									: null,
							]
								.filter(Boolean)
								.join(" · ")}
						</p>
					)}
					<p className="pt-1 text-muted-foreground text-xs">
						What each one claimed is listed in Details.
					</p>
				</div>
			)}
		</div>
	);
}
