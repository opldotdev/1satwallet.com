"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import type { TokenDraft } from "@/lib/wallet/create-token";

/**
 * The fields every token standard asks for, in one order: symbol, decimals,
 * supply type, supply. The sheet keeps their values, so a switch of
 * standard keeps them.
 */
export function TokenDraftFields({
	draft,
	onDraftChange,
	symbolMaxLength,
	symbolHint,
	mintableHint,
}: {
	draft: TokenDraft;
	onDraftChange: (draft: TokenDraft) => void;
	symbolMaxLength: number;
	/** A line under the symbol, such as "Optional." */
	symbolHint?: string;
	/** What a mintable token starts with, and where minting happens. */
	mintableHint: string;
}) {
	const set = <K extends keyof TokenDraft>(key: K, value: TokenDraft[K]) =>
		onDraftChange({ ...draft, [key]: value });
	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-2">
				<Label htmlFor="create-token-symbol">Symbol</Label>
				<Input
					aria-describedby={symbolHint ? "create-token-symbol-hint" : undefined}
					autoComplete="off"
					id="create-token-symbol"
					maxLength={symbolMaxLength}
					value={draft.symbol}
					onChange={(event) => set("symbol", event.target.value)}
				/>
				{symbolHint ? (
					<p
						className="text-muted-foreground text-xs"
						id="create-token-symbol-hint"
					>
						{symbolHint}
					</p>
				) : null}
			</div>
			<div className="flex flex-col gap-2">
				<Label htmlFor="create-token-decimals">Decimals</Label>
				<Input
					id="create-token-decimals"
					inputMode="numeric"
					value={draft.decimals}
					onChange={(event) => set("decimals", event.target.value)}
				/>
			</div>
			<div className="flex flex-col gap-2">
				<Label htmlFor="create-token-supply-type">Supply type</Label>
				<Select
					value={draft.supply}
					onValueChange={(value: TokenDraft["supply"]) => set("supply", value)}
				>
					<SelectTrigger className="w-full" id="create-token-supply-type">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="fixed">Fixed</SelectItem>
						<SelectItem value="mintable">Mintable</SelectItem>
					</SelectContent>
				</Select>
			</div>
			{draft.supply === "fixed" ? (
				<div className="flex flex-col gap-2">
					<Label htmlFor="create-token-supply">Supply</Label>
					<Input
						id="create-token-supply"
						inputMode="decimal"
						value={draft.amount}
						onChange={(event) => set("amount", event.target.value)}
					/>
				</div>
			) : (
				<p className="text-muted-foreground text-sm">{mintableHint}</p>
			)}
		</div>
	);
}
