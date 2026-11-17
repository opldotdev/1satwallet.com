"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { type ChangeEvent, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { useSound } from "@/hooks/use-sound";
import { isOneColorAvailable } from "@/lib/chain-endpoints";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import {
	type CreateTokenFormProps,
	parseDraftDecimals,
} from "@/lib/wallet/create-token";
import {
	formatOneColorAmount,
	ONE_COLOR_MAX_ICON_BYTES,
	ONE_COLOR_MAX_SYMBOL_LENGTH,
	type OneColorDeployInput,
	type OneColorIcon,
	oneColorDeployFailureMessage,
	oneColorDeployInputError,
	oneColorSupplyError,
	parseOneColorAmount,
	runOneColorDeploy,
} from "@/lib/wallet/one-color-actions";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import { TokenDraftFields } from "./token-draft-fields";

type SelectedIcon = OneColorIcon & { name: string; bytes: Uint8Array };

const formatBytes = (bytes: number): string =>
	bytes < 1_000 ? `${bytes} B` : `${(bytes / 1_000).toFixed(1)} KB`;

function logDeployFailure(operation: string, cause: unknown) {
	console.error(`[1color] ${operation} failed:`, cause);
	reportDiagnostic({
		category: "action",
		code: "action.failed",
		operation: `wallet.1color.${operation}`,
		recoverable: true,
		context: { retryable: true },
	});
}

/**
 * The 1Color body of the Create token sheet (testnet only): the shared
 * fields and an optional icon embedded in the deploy, then a review, then the
 * deploy through `colorContext`. Fixed supply deploys the whole amount;
 * mintable deploys amount 0, a mint authority kept by this wallet.
 */
export function OneColorDeployForm({
	draft,
	onDraftChange,
	onStatusChange,
	onCreated,
	onCancel,
}: CreateTokenFormProps) {
	const queryClient = useQueryClient();
	const { play } = useSound();
	const { chain, colorContext, connectionMode, refreshBalance } =
		useWalletToolbox();
	const [icon, setIcon] = useState<SelectedIcon | null>(null);
	const [review, setReview] = useState<OneColorDeployInput | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		onStatusChange({ busy, reviewing: review !== null });
	}, [busy, review, onStatusChange]);

	const chooseIcon = useCallback(
		async (event: ChangeEvent<HTMLInputElement>) => {
			const file = event.target.files?.[0];
			event.target.value = "";
			setError(null);
			if (!file) return;
			if (file.size > ONE_COLOR_MAX_ICON_BYTES) {
				setError(
					`The icon is ${formatBytes(file.size)}. Use one of at most ${ONE_COLOR_MAX_ICON_BYTES / 1_000} KB.`,
				);
				return;
			}
			try {
				const bytes = new Uint8Array(await file.arrayBuffer());
				const selected = { name: file.name, mediaType: file.type, bytes };
				const invalid = oneColorDeployInputError({
					amount: 0n,
					decimals: 0,
					icon: selected,
				});
				if (invalid) {
					setError(oneColorDeployFailureMessage(invalid));
					return;
				}
				setIcon(selected);
			} catch (cause) {
				logDeployFailure("icon-read", cause);
				setError("The icon file could not be read. Choose it again.");
			}
		},
		[],
	);

	const prepareReview = useCallback(() => {
		setError(null);
		const decimals = parseDraftDecimals(draft.decimals);
		const trimmedSymbol = draft.symbol.trim();
		let atomic = 0n;
		if (draft.supply === "fixed") {
			const parsed = parseOneColorAmount(draft.amount, decimals);
			if (parsed === null) {
				setError(oneColorSupplyError(draft.amount, decimals));
				return;
			}
			atomic = parsed;
		}
		const input: OneColorDeployInput = {
			amount: atomic,
			decimals,
			...(trimmedSymbol ? { symbol: trimmedSymbol } : {}),
			...(icon ? { icon } : {}),
		};
		const invalid = oneColorDeployInputError(input);
		if (invalid) {
			setError(oneColorDeployFailureMessage(invalid));
			return;
		}
		setReview(input);
	}, [draft, icon]);

	const deploy = useCallback(async () => {
		if (!(colorContext && review)) return;
		setBusy(true);
		setError(null);
		// Holdings are re-read before `busy` clears, so Create stays disabled
		// until the wallet's own read shows whether a deploy landed.
		const outcome = await runOneColorDeploy(colorContext, review, {
			log: logDeployFailure,
			refresh: async () => {
				refreshBalance();
				await queryClient.invalidateQueries({ queryKey: ["one-color"] });
			},
		});
		if (outcome.ok) {
			play("success");
			onCreated({
				standard: "1color",
				id: outcome.assetId,
				message: `${review.symbol ?? "Your token"} was created. The 1Color overlay must admit it before it can be sent.`,
			});
		} else {
			// A failure after signing may have deployed: never leave Create
			// one tap away from a second deploy.
			if (outcome.mayHaveBeenSent) setReview(null);
			setError(outcome.message);
			play("error");
		}
		setBusy(false);
	}, [colorContext, onCreated, play, queryClient, refreshBalance, review]);

	if (!isOneColorAvailable(chain)) return null;

	return (
		<>
			{review ? (
				<div className="flex flex-col gap-4">
					<Notice tone="warning">
						{review.amount > 0n
							? "The whole supply is created now and can never change."
							: "The supply starts at zero. This wallet keeps the only mint authority; whoever holds it can mint."}
					</Notice>
					<DetailList className="rounded-xl border p-4">
						<DetailRow label="Standard" mono={false}>
							1Color
						</DetailRow>
						<DetailRow label="Symbol">{review.symbol ?? "None"}</DetailRow>
						<DetailRow label="Decimals">{review.decimals}</DetailRow>
						<DetailRow label="Supply">
							{review.amount > 0n
								? formatOneColorAmount(review.amount, review.decimals)
								: "Mintable"}
						</DetailRow>
						<DetailRow label="Icon" mono={false}>
							{review.icon
								? `${formatBytes(review.icon.bytes.length)} ${review.icon.mediaType}`
								: "None"}
						</DetailRow>
						<DetailRow label="Fee" mono={false}>
							Set by your wallet
						</DetailRow>
					</DetailList>
				</div>
			) : (
				<>
					{colorContext ? null : (
						<Notice>
							{connectionMode === "external"
								? "1Color tokens are created with this site's own wallet. A connected wallet can't create them: disconnect it and unlock this site's wallet."
								: "1Color tokens are created with this site's own wallet. Unlock it to continue."}
						</Notice>
					)}
					<TokenDraftFields
						draft={draft}
						mintableHint="The supply starts at zero. Mint from the token's page."
						onDraftChange={onDraftChange}
						symbolHint="Optional."
						symbolMaxLength={ONE_COLOR_MAX_SYMBOL_LENGTH}
					/>
					<div className="flex flex-col gap-2">
						<Label htmlFor="create-token-icon">Icon (optional)</Label>
						<Input
							accept="image/*"
							id="create-token-icon"
							onChange={(event) => void chooseIcon(event)}
							type="file"
						/>
						{icon ? (
							<div className="flex items-center gap-2 text-muted-foreground text-sm">
								<span className="min-w-0 truncate">{icon.name}</span>
								<span className="shrink-0">
									{formatBytes(icon.bytes.length)}
								</span>
								<Button
									className="ml-auto shrink-0"
									onClick={() => setIcon(null)}
									size="sm"
									type="button"
									variant="ghost"
								>
									Remove
								</Button>
							</div>
						) : (
							<p className="text-muted-foreground text-xs">
								Stored in the token, so it is paid for when you create it: at
								most {ONE_COLOR_MAX_ICON_BYTES / 1_000} KB.
							</p>
						)}
					</div>
				</>
			)}
			{error ? (
				<p className="text-destructive text-sm" role="alert">
					{error}
				</p>
			) : null}
			<DialogFooter>
				<Button
					disabled={busy}
					onClick={() => (review ? setReview(null) : onCancel())}
					type="button"
					variant="outline"
				>
					{review ? "Edit" : "Cancel"}
				</Button>
				<Button
					disabled={busy || !colorContext}
					onClick={() => void (review ? deploy() : prepareReview())}
					type="button"
				>
					{busy ? (
						<Loader2 className="animate-spin" data-icon="inline-start" />
					) : null}
					{review ? "Create token" : "Review"}
				</Button>
			</DialogFooter>
		</>
	);
}
