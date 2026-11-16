"use client";

import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { TestnetBadge } from "@/components/wallet/testnet-badge";
import type { Chain } from "@/lib/chain-endpoints";
import { cn } from "@/lib/utils";

/**
 * The account's network, fixed at create or import. Mainnet is the normal
 * path and needs nothing from the person: Testnet is a developer option kept
 * behind a collapsed "Developer options" row. The row opens by itself when
 * Testnet is already selected or a note explains a preselection.
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
	const [opened, setOpened] = useState(false);
	const open = opened || value === "test" || Boolean(note);
	const panelId = useId();
	const switchId = useId();

	return (
		<div className="grid gap-2" id="network-choice">
			<button
				aria-controls={panelId}
				aria-expanded={open}
				className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
				onClick={() => setOpened((current) => !current)}
				type="button"
			>
				Developer options
				<ChevronDown
					aria-hidden
					className={cn("size-3 transition-transform", open && "rotate-180")}
				/>
			</button>
			{open ? (
				<div className="grid gap-2 rounded-lg bg-muted p-3" id={panelId}>
					<div className="flex items-center justify-between gap-3">
						<Label className="text-sm" htmlFor={switchId}>
							Use testnet
						</Label>
						<div className="flex items-center gap-2">
							{value === "test" ? <TestnetBadge /> : null}
							<Switch
								checked={value === "test"}
								id={switchId}
								onCheckedChange={(checked) =>
									onChange(checked ? "test" : "main")
								}
							/>
						</div>
					</div>
					<p className="text-xs text-muted-foreground">
						For development. Testnet coins have no real value, and an account's
						network can't be changed later.
					</p>
					{note ? (
						<p className="text-xs text-muted-foreground">{note}</p>
					) : null}
				</div>
			) : null}
		</div>
	);
}
