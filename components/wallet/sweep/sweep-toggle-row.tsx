"use client";

import { useId } from "react";
import { Switch } from "@/components/ui/switch";

/** A labelled switch for including a kind of asset in the sweep. */
export function SweepToggleRow({
	label,
	hint,
	checked,
	onCheckedChange,
	disabled,
}: {
	label: string;
	hint?: string;
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
	disabled?: boolean;
}) {
	const id = useId();
	return (
		<div className="flex min-h-14 items-center justify-between gap-4 rounded-xl border bg-card px-4 py-3">
			<label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
				<span className="block font-medium text-sm">{label}</span>
				{hint && (
					<span className="block text-muted-foreground text-xs">{hint}</span>
				)}
			</label>
			<Switch
				id={id}
				checked={checked}
				onCheckedChange={onCheckedChange}
				disabled={disabled}
			/>
		</div>
	);
}
