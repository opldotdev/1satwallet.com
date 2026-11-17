"use client";

import { deployBsv21Mint } from "@1sat/actions";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import { DialogFooter } from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";
import { useSound } from "@/hooks/use-sound";
import { useBsv21Availability } from "@/lib/hooks/use-stack-features";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import {
	formatBsv21Amount,
	parseBsv21Amount,
} from "@/lib/wallet/bsv21-actions";
import {
	BSV21_ACTION_CONFIRMATION_MISSING,
	bsv21AuthorityFailureMessage,
	executeBsv21AuthorityIntent,
	prepareLiveBsv21AuthorityExecution,
} from "@/lib/wallet/bsv21-authority";
import {
	type CreateTokenFormProps,
	parseDraftDecimals,
} from "@/lib/wallet/create-token";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import { TokenDraftFields } from "./token-draft-fields";
import { Bsv21UnavailableNotice } from "./token-grid";

const VALID_SYMBOL = /^[^\p{Cc}\p{Cs}]{1,32}$/u;

type DeploymentReview =
	| { kind: "fixed"; symbol: string; decimals: number; amount: bigint }
	| { kind: "mintable"; symbol: string; decimals: number };

/**
 * The BSV-21 body of the Create token sheet: the shared fields, then a
 * review, then the deploy. Fixed supply deploys the whole supply to this
 * wallet (`deployBsv21Mint`); mintable deploys zero supply and one mint
 * authority kept by this wallet.
 */
export function Bsv21DeployForm({
	draft,
	onDraftChange,
	onStatusChange,
	onCreated,
	onCancel,
}: CreateTokenFormProps) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const { play } = useSound();
	const { oneSatContext, refreshBalance } = useWalletToolbox();
	const { available: bsv21Available } = useBsv21Availability();
	const [review, setReview] = useState<DeploymentReview | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const decimals = parseDraftDecimals(draft.decimals);
	const ready = Boolean(oneSatContext) && bsv21Available;

	useEffect(() => {
		onStatusChange({ busy, reviewing: review !== null });
	}, [busy, review, onStatusChange]);

	const prepareReview = useCallback(() => {
		setError(null);
		const symbol = draft.symbol.trim();
		if (!VALID_SYMBOL.test(symbol)) {
			setError("Enter a printable symbol between 1 and 32 characters.");
			return;
		}
		if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
			setError("Decimals must be a whole number from 0 through 18.");
			return;
		}
		if (draft.supply === "mintable") {
			setReview({ kind: "mintable", symbol, decimals });
			return;
		}
		const atomic = parseBsv21Amount(draft.amount, decimals);
		if (!atomic) {
			setError(`Enter a positive supply with at most ${decimals} decimals.`);
			return;
		}
		setReview({ kind: "fixed", symbol, decimals, amount: atomic });
	}, [decimals, draft]);

	const deploy = useCallback(async () => {
		if (!(oneSatContext && review && bsv21Available)) return;
		setBusy(true);
		setError(null);
		try {
			const symbol = draft.symbol.trim();
			const atomic =
				review.kind === "fixed"
					? parseBsv21Amount(draft.amount, decimals)
					: null;
			if (
				review.kind !== draft.supply ||
				review.symbol !== symbol ||
				review.decimals !== decimals ||
				!VALID_SYMBOL.test(symbol) ||
				!Number.isInteger(decimals) ||
				(review.kind === "fixed" && atomic !== review.amount)
			) {
				setReview(null);
				throw new Error("Review details changed. Review the token again.");
			}
			await prepareLiveBsv21AuthorityExecution(oneSatContext);
			const result =
				review.kind === "fixed"
					? await deployBsv21Mint.execute(oneSatContext, {
							symbol: review.symbol,
							amount: review.amount,
							decimals: review.decimals,
							destination: { counterparty: "self" },
						})
					: await executeBsv21AuthorityIntent(oneSatContext, {
							kind: "deploy",
							symbol: review.symbol,
							decimals: review.decimals,
						});
			if (result.error) throw new Error(result.error);
			if (!result.txid) throw new Error(BSV21_ACTION_CONFIRMATION_MISSING);
			play("success");
			onCreated({
				standard: "bsv21",
				id: result.tokenId ?? null,
				message:
					review.kind === "fixed"
						? `${review.symbol} was created. It shows in your list once the BSV-21 overlay indexes it.`
						: `${review.symbol} was created with no supply yet. Mint from its page once the BSV-21 overlay indexes it.`,
			});
			refreshBalance();
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["wallet-balance"] }),
				queryClient.invalidateQueries({ queryKey: ["bsv21-market"] }),
			]);
			router.refresh();
		} catch (cause) {
			console.error(`[bsv21] deploy (${review.kind}) failed:`, cause);
			reportDiagnostic({
				category: "action",
				code: "action.failed",
				operation: `wallet.bsv21.deploy-${review.kind}`,
				recoverable: true,
				context: { retryable: true },
			});
			setError(bsv21AuthorityFailureMessage(cause));
			play("error");
		} finally {
			setBusy(false);
		}
	}, [
		bsv21Available,
		decimals,
		draft,
		oneSatContext,
		onCreated,
		play,
		queryClient,
		refreshBalance,
		review,
		router,
	]);

	return (
		<>
			{review ? (
				<div className="flex flex-col gap-4">
					<Notice tone="warning">
						{review.kind === "fixed"
							? "The whole supply is created now and can never change."
							: "The supply starts at zero. This wallet keeps the only mint authority; whoever holds it can mint."}
					</Notice>
					<DetailList className="rounded-xl border p-4">
						<DetailRow label="Standard" mono={false}>
							BSV-21
						</DetailRow>
						<DetailRow label="Symbol">{review.symbol}</DetailRow>
						<DetailRow label="Decimals">{review.decimals}</DetailRow>
						<DetailRow label="Supply">
							{review.kind === "fixed"
								? formatBsv21Amount(review.amount, review.decimals)
								: "Mintable"}
						</DetailRow>
						<DetailRow label="Fee" mono={false}>
							Set by your wallet
						</DetailRow>
					</DetailList>
				</div>
			) : (
				<>
					{oneSatContext ? (
						<Bsv21UnavailableNotice />
					) : (
						<Notice>Unlock or connect a wallet to create a token.</Notice>
					)}
					<TokenDraftFields
						draft={draft}
						mintableHint="The supply starts at zero. Mint from the token's page once the BSV-21 overlay indexes it."
						onDraftChange={onDraftChange}
						symbolMaxLength={32}
					/>
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
					disabled={busy || !ready}
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
