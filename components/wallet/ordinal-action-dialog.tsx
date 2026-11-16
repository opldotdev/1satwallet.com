"use client";

import type { WalletOutput } from "@1sat/actions";
import { Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { useSound } from "@/hooks/use-sound";
import { LISTING_CREATE_OFF_MESSAGE } from "@/lib/ordlock";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import {
	executeOrdinalOperation,
	type OrdinalDestinationKind,
	type OrdinalOperation,
	ordinalActionFailureMessage,
	ordinalAssetId,
	validateOrdinalDestination,
} from "@/lib/wallet/ordinal-actions";
import {
	getDisplayOutpoint,
	getName,
	shortOutpoint,
} from "@/lib/wallet/wallet-output-utils";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

export type OrdinalActionKind = "send" | "burn" | "sell" | "cancel";

interface OrdinalActionDialogProps {
	kind: OrdinalActionKind;
	ordinals: WalletOutput[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSuccess: () => Promise<void> | void;
}

const TITLES: Record<OrdinalActionKind, string> = {
	send: "Send ordinals",
	burn: "Burn ordinals",
	sell: "Listing create is off",
	cancel: "Cancel listing",
};

export function OrdinalActionDialog({
	kind,
	ordinals,
	open,
	onOpenChange,
	onSuccess,
}: OrdinalActionDialogProps) {
	const { oneSatContext, chain } = useWalletToolbox();
	const { play } = useSound();
	const [destinationKind, setDestinationKind] =
		useState<OrdinalDestinationKind>("address");
	const [destination, setDestination] = useState("");
	const [burnConfirmation, setBurnConfirmation] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const ids = useMemo(
		() => ordinals.map(ordinalAssetId).filter((id): id is string => !!id),
		[ordinals],
	);
	const hasCompleteIds =
		ids.length === ordinals.length && new Set(ids).size === ids.length;
	const destinationIsValid = validateOrdinalDestination(
		destination,
		destinationKind,
		chain,
	);
	const canSubmit =
		!!oneSatContext &&
		hasCompleteIds &&
		!busy &&
		((kind === "send" && destinationIsValid) ||
			(kind === "burn" && burnConfirmation === "BURN") ||
			kind === "cancel");

	const reset = useCallback(() => {
		setDestinationKind("address");
		setDestination("");
		setBurnConfirmation("");
		setError(null);
	}, []);

	const setOpen = useCallback(
		(next: boolean) => {
			if (!next && !busy) reset();
			onOpenChange(next);
		},
		[busy, onOpenChange, reset],
	);

	const run = useCallback(async () => {
		if (!oneSatContext || !hasCompleteIds || ordinals.length === 0) {
			setError(
				"This selection is no longer actionable. Refresh and select the ordinals again.",
			);
			return;
		}
		let operation: OrdinalOperation;
		if (kind === "send") {
			if (!destinationIsValid) {
				setError(
					destinationKind === "address"
						? `Enter a valid ${chain}net address.`
						: "Enter a valid identity key (66 hex characters).",
				);
				return;
			}
			operation = {
				kind,
				ids,
				destinationKind,
				destination: destination.trim(),
			} as const;
		} else if (kind === "burn") {
			if (burnConfirmation !== "BURN") return;
			operation = { kind, ids } as const;
		} else if (kind === "sell") {
			setError(LISTING_CREATE_OFF_MESSAGE);
			return;
		} else {
			if (ids.length !== 1) {
				setError("Select one active listing to cancel.");
				return;
			}
			operation = { kind, id: ids[0] } as const;
		}

		setBusy(true);
		setError(null);
		try {
			const result = await executeOrdinalOperation(oneSatContext, operation);
			if (result.error) throw new Error(result.error);
			play("success");
			await onSuccess();
			reset();
			onOpenChange(false);
		} catch (cause) {
			reportDiagnostic({
				category: "action",
				code: "action.failed",
				operation: `wallet.ordinal.${kind}`,
				recoverable: true,
				context: { retryable: true },
			});
			console.error(`[ordinals] ${kind} failed`, { count: ids.length, cause });
			setError(ordinalActionFailureMessage(cause));
			play("error");
		} finally {
			setBusy(false);
		}
	}, [
		burnConfirmation,
		chain,
		destination,
		destinationIsValid,
		destinationKind,
		hasCompleteIds,
		ids,
		kind,
		onOpenChange,
		onSuccess,
		oneSatContext,
		ordinals.length,
		play,
		reset,
	]);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent showCloseButton={!busy}>
				<DialogHeader>
					<DialogTitle>{TITLES[kind]}</DialogTitle>
					<DialogDescription>
						{ordinals.length} ordinal{ordinals.length === 1 ? "" : "s"}{" "}
						selected. Your wallet asks you to approve the transaction first.
					</DialogDescription>
				</DialogHeader>

				<ul className="max-h-48 divide-y overflow-y-auto rounded-lg border text-sm">
					{ordinals.map((ordinal) => {
						const outpoint = getDisplayOutpoint(ordinal);
						return (
							<li
								key={ordinal.outpoint}
								className="flex items-baseline justify-between gap-3 px-3 py-2"
							>
								<span className="min-w-0 truncate font-medium">
									{getName(ordinal) ?? "Ordinal"}
								</span>
								<span
									className="shrink-0 font-mono text-xs text-muted-foreground"
									title={outpoint}
								>
									{shortOutpoint(outpoint)}
								</span>
							</li>
						);
					})}
				</ul>

				{!hasCompleteIds && (
					<Notice tone="danger">
						At least one ordinal is missing its wallet asset ID. Refresh before
						continuing.
					</Notice>
				)}

				{kind === "send" && (
					<div className="flex flex-col gap-3">
						<fieldset className="grid grid-cols-2 gap-2">
							<legend className="sr-only">Send to</legend>
							<Button
								type="button"
								aria-pressed={destinationKind === "address"}
								variant={destinationKind === "address" ? "default" : "outline"}
								onClick={() => setDestinationKind("address")}
							>
								Address
							</Button>
							<Button
								type="button"
								aria-pressed={destinationKind === "counterparty"}
								variant={
									destinationKind === "counterparty" ? "default" : "outline"
								}
								onClick={() => setDestinationKind("counterparty")}
							>
								Identity key
							</Button>
						</fieldset>
						<div className="flex flex-col gap-2">
							<Label htmlFor="ordinal-destination">
								{destinationKind === "address"
									? "Recipient address"
									: "Recipient identity key"}
							</Label>
							<Input
								id="ordinal-destination"
								autoComplete="off"
								spellCheck={false}
								className="font-mono"
								value={destination}
								onChange={(event) => setDestination(event.target.value)}
							/>
						</div>
					</div>
				)}

				{kind === "sell" && <Notice>{LISTING_CREATE_OFF_MESSAGE}</Notice>}

				{kind === "burn" && (
					<div className="flex flex-col gap-3">
						<Notice tone="danger" title="Burning can't be undone">
							Every ordinal listed above is destroyed.
						</Notice>
						<div className="flex flex-col gap-2">
							<Label htmlFor="ordinal-burn-confirmation">
								Type BURN to confirm{" "}
								{ordinals.length === 1 ? "it" : `all ${ordinals.length}`}
							</Label>
							<Input
								id="ordinal-burn-confirmation"
								autoComplete="off"
								value={burnConfirmation}
								onChange={(event) => setBurnConfirmation(event.target.value)}
							/>
						</div>
					</div>
				)}

				{kind === "cancel" && (
					<p className="text-sm text-muted-foreground">
						This ends the listing and returns the ordinal to your wallet.
					</p>
				)}

				{error && <Notice tone="danger">{error}</Notice>}

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						disabled={busy}
						onClick={() => setOpen(false)}
					>
						Keep selection
					</Button>
					<Button
						type="button"
						variant={kind === "burn" ? "destructive" : "default"}
						disabled={!canSubmit}
						onClick={() => void run()}
					>
						{busy && <Loader2 className="animate-spin" />}
						{busy ? "Waiting for wallet…" : TITLES[kind]}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
