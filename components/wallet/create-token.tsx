"use client";

import { Plus } from "lucide-react";
import { type KeyboardEvent, useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { useWalletChain } from "@/lib/hooks/use-wallet-chain";
import { cn } from "@/lib/utils";
import {
	activeTokenStandard,
	type CreatedToken,
	EMPTY_TOKEN_DRAFT,
	TOKEN_STANDARD_HINT,
	TOKEN_STANDARD_LABEL,
	type TokenDraft,
	type TokenStandard,
	tokenStandardsFor,
} from "@/lib/wallet/create-token";
import { Bsv21DeployForm } from "./bsv21-deploy";
import { OneColorDeployForm } from "./one-color-deploy";

const IDLE = { busy: false, reviewing: false };

/**
 * "BSV-21 | 1Color": which standard the sheet creates. A radio group of two
 * 44px segments, moved between with the arrow keys, and one line on how the
 * picked standard differs.
 */
export function StandardPicker({
	standards,
	value,
	onChange,
	disabled,
}: {
	standards: readonly TokenStandard[];
	value: TokenStandard;
	onChange: (standard: TokenStandard) => void;
	disabled: boolean;
}) {
	const group = useRef<HTMLDivElement>(null);
	const move = (event: KeyboardEvent<HTMLDivElement>) => {
		const step =
			event.key === "ArrowRight" || event.key === "ArrowDown"
				? 1
				: event.key === "ArrowLeft" || event.key === "ArrowUp"
					? -1
					: 0;
		if (step === 0 || disabled) return;
		event.preventDefault();
		const index =
			(standards.indexOf(value) + step + standards.length) % standards.length;
		onChange(standards[index]);
		group.current
			?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
			[index]?.focus();
	};
	return (
		<div className="flex flex-col gap-2">
			<div
				aria-label="Token standard"
				className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1"
				onKeyDown={move}
				ref={group}
				role="radiogroup"
			>
				{standards.map((standard) => {
					const checked = standard === value;
					return (
						<Button
							aria-checked={checked}
							className={cn(
								"w-full",
								checked
									? "bg-background text-foreground shadow-xs hover:bg-background"
									: "text-muted-foreground",
							)}
							disabled={disabled}
							key={standard}
							onClick={() => onChange(standard)}
							role="radio"
							tabIndex={checked ? 0 : -1}
							type="button"
							variant="ghost"
						>
							{TOKEN_STANDARD_LABEL[standard]}
						</Button>
					);
				})}
			</div>
			<p className="text-muted-foreground text-sm">
				{TOKEN_STANDARD_HINT[value]}
			</p>
		</div>
	);
}

/**
 * The Tokens section's one Create token button and its sheet. Mainnet
 * creates BSV-21 only and shows no picker; testnet first asks BSV-21 or
 * 1Color. Symbol, decimals, supply type and supply are kept here, so a
 * switch of standard keeps what was typed.
 */
export function CreateToken({
	onCreated,
}: {
	onCreated: (created: CreatedToken) => void;
}) {
	const chain = useWalletChain();
	const standards = tokenStandardsFor(chain);
	const [open, setOpen] = useState(false);
	const [picked, setPicked] = useState<TokenStandard>("bsv21");
	const [draft, setDraft] = useState<TokenDraft>(EMPTY_TOKEN_DRAFT);
	const [status, setStatus] = useState(IDLE);
	const standard = activeTokenStandard(chain, picked);

	const close = useCallback(() => {
		setOpen(false);
		setPicked("bsv21");
		setDraft(EMPTY_TOKEN_DRAFT);
		setStatus(IDLE);
	}, []);

	const changeOpen = (next: boolean) => {
		if (status.busy) return;
		if (next) setOpen(true);
		else close();
	};

	const created = useCallback(
		(token: CreatedToken) => {
			close();
			onCreated(token);
		},
		[close, onCreated],
	);

	const form = {
		draft,
		onDraftChange: setDraft,
		onStatusChange: setStatus,
		onCreated: created,
		onCancel: close,
	};

	return (
		<Dialog open={open} onOpenChange={changeOpen}>
			<DialogTrigger asChild>
				<Button>
					<Plus data-icon="inline-start" /> Create token
				</Button>
			</DialogTrigger>
			<DialogContent showCloseButton={!status.busy}>
				<DialogHeader>
					<DialogTitle>Create token</DialogTitle>
					<DialogDescription>
						{status.reviewing
							? "Check the details. Creating a token can't be undone."
							: "Set the symbol and supply, then review."}
					</DialogDescription>
				</DialogHeader>
				{standards.length > 1 ? (
					<StandardPicker
						disabled={status.busy || status.reviewing}
						onChange={setPicked}
						standards={standards}
						value={standard}
					/>
				) : null}
				{standard === "1color" ? (
					<OneColorDeployForm {...form} />
				) : (
					<Bsv21DeployForm {...form} />
				)}
			</DialogContent>
		</Dialog>
	);
}
