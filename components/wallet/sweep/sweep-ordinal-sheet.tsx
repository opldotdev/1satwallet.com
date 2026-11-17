"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { MigrationOrdinalCard } from "@/components/wallet/migration-ordinal-card";
import { useIsMobile } from "@/hooks/use-mobile";
import type { SweepOrdinal } from "@/lib/wallet/sweep-summary";

const PAGE = 30;

/**
 * Pick which ordinals move. Opens from the collectibles step; tiles load in
 * pages of 30 as the list grows, so frames don't all load at once.
 */
export function SweepOrdinalSheet({
	open,
	onOpenChange,
	ordinals,
	selected,
	onToggle,
	onSelectAll,
	onDeselectAll,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	ordinals: SweepOrdinal[];
	selected: ReadonlySet<string>;
	onToggle: (outpoint: string) => void;
	onSelectAll: () => void;
	onDeselectAll: () => void;
}) {
	const isMobile = useIsMobile();
	const [shown, setShown] = useState(PAGE);
	const count = ordinals.filter((o) => selected.has(o.outpoint)).length;
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side={isMobile ? "bottom" : "right"}
				className={
					isMobile ? "max-h-[85dvh] rounded-t-xl" : "w-full sm:max-w-xl"
				}
			>
				<SheetHeader className="pr-12">
					<SheetTitle>Choose ordinals</SheetTitle>
					<SheetDescription>
						{count} of {ordinals.length} selected
					</SheetDescription>
					<div className="flex gap-2 pt-1">
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={onSelectAll}
							disabled={count === ordinals.length}
						>
							Select all
						</Button>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={onDeselectAll}
							disabled={count === 0}
						>
							Deselect all
						</Button>
					</div>
				</SheetHeader>
				<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4">
					<div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
						{ordinals.slice(0, shown).map((ordinal) => (
							<MigrationOrdinalCard
								key={ordinal.outpoint}
								ordinal={ordinal}
								isSelected={selected.has(ordinal.outpoint)}
								onToggle={() => onToggle(ordinal.outpoint)}
							/>
						))}
					</div>
					{shown < ordinals.length && (
						<Button
							type="button"
							variant="ghost"
							className="mt-3 w-full"
							onClick={() => setShown((n) => n + PAGE)}
						>
							Show more ({ordinals.length - shown})
						</Button>
					)}
				</div>
				<SheetFooter className="border-t">
					<Button type="button" onClick={() => onOpenChange(false)}>
						Done
					</Button>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	);
}
