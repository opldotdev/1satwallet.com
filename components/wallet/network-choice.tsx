"use client";

import { Button } from "@/components/ui/button";
import type { Chain } from "@/lib/chain-endpoints";

const OPTIONS: { value: Chain; label: string }[] = [
	{ value: "main", label: "Mainnet" },
	{ value: "test", label: "Testnet" },
];

/**
 * The account's network, chosen once at create or import. Mainnet first and by
 * default, as in the iOS app's NetworkChoice.
 */
export function NetworkChoice({
	value,
	onChange,
	note,
}: {
	value: Chain;
	onChange: (chain: Chain) => void;
	/** Why an option was preselected, if it was. */
	note?: string;
}) {
	return (
		<fieldset className="grid gap-2" id="network-choice">
			<legend className="mb-2 text-xs text-muted-foreground">
				Network. This cannot be changed later.
			</legend>
			<div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
				{OPTIONS.map((option) => (
					<Button
						aria-pressed={value === option.value}
						key={option.value}
						onClick={() => onChange(option.value)}
						size="sm"
						type="button"
						variant={value === option.value ? "outline" : "ghost"}
					>
						{option.label}
					</Button>
				))}
			</div>
			{note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
			{value === "test" ? (
				<p className="text-xs text-muted-foreground">
					Testnet coins have no real value.
				</p>
			) : null}
		</fieldset>
	);
}
