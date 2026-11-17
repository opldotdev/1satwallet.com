"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useSound } from "@/hooks/use-sound";
import { useBsv21Availability } from "@/lib/hooks/use-stack-features";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import {
	formatBsv21Amount,
	isBsv21TokenId,
	normalizeBsv21TokenId,
	parseBsv21Amount,
	parseBsv21Destination,
} from "@/lib/wallet/bsv21-actions";
import {
	BSV21_ACTION_CONFIRMATION_MISSING,
	type Bsv21AuthorityIntent,
	bsv21AuthorityFailureMessage,
	confirmsPermanentMintTermination,
	executeBsv21AuthorityIntent,
	permanentMintTerminationConfirmation,
	prepareLiveBsv21AuthorityExecution,
} from "@/lib/wallet/bsv21-authority";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

type AuthorityOperation =
	| "mint"
	| "transfer"
	| "terminate-authority"
	| "terminate";
type AuthorityReview =
	| {
			kind: "mint";
			tokenId: string;
			symbol: string;
			decimals: number;
			amount: bigint;
	  }
	| {
			kind: "terminate-authority";
			tokenId: string;
			symbol: string;
	  }
	| {
			kind: "terminate";
			tokenId: string;
			symbol: string;
			decimals: number;
			amount: bigint;
	  }
	| {
			kind: "transfer";
			tokenId: string;
			symbol: string;
			destination: { address?: string; counterparty?: string };
	  };

function isPermanentTermination(kind: AuthorityOperation): boolean {
	return kind === "terminate-authority" || kind === "terminate";
}

const OPERATION_LABEL: Record<AuthorityOperation, string> = {
	mint: "Mint and keep minting",
	transfer: "Give minting to someone else",
	"terminate-authority": "End minting without a final mint",
	terminate: "Final mint, then end minting",
};

/**
 * Mint a BSV-21 token with this wallet's mint authority, give the authority
 * away, or end minting for good. Opens from `trigger`: the token page's Mint
 * (its token ID fixed) or the Tokens section's "Mint by token ID".
 */
export function Bsv21AuthorityManager({
	trigger,
	tokenId: fixedTokenId,
	onDone,
}: {
	trigger: ReactNode;
	/** The token, when the manager opens from its page. */
	tokenId?: string;
	/** What happened, once the wallet has submitted the action. */
	onDone: (message: string) => void;
}) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const { play } = useSound();
	const { chain, oneSatContext, refreshBalance } = useWalletToolbox();
	const { available: bsv21Available } = useBsv21Availability();
	const [open, setOpen] = useState(false);
	const [operation, setOperation] = useState<AuthorityOperation>("mint");
	const [tokenId, setTokenId] = useState(fixedTokenId ?? "");
	const [amount, setAmount] = useState("");
	const [destination, setDestination] = useState("");
	const [confirmation, setConfirmation] = useState("");
	const [review, setReview] = useState<AuthorityReview | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const prepareReview = useCallback(async () => {
		setError(null);
		if (!(oneSatContext?.services && isBsv21TokenId(tokenId))) {
			setError("Enter a canonical BSV21 token ID in txid_vout format.");
			return;
		}
		setBusy(true);
		try {
			const normalizedTokenId = normalizeBsv21TokenId(tokenId);
			oneSatContext.services.bsv21.clearCache();
			const details =
				await oneSatContext.services.bsv21.getTokenDetails(normalizedTokenId);
			if (!details.status.is_active) {
				setError("This token is not active on the configured BSV21 overlay.");
				return;
			}
			const indexedDecimals = details.token.dec ?? 0;
			const decimals =
				typeof indexedDecimals === "number"
					? indexedDecimals
					: /^\d+$/.test(indexedDecimals)
						? Number.parseInt(indexedDecimals, 10)
						: Number.NaN;
			const symbol = details.token.sym || normalizedTokenId.slice(0, 8);
			if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
				setError("The indexed token has invalid decimal metadata.");
				return;
			}
			if (operation === "transfer") {
				const parsed = parseBsv21Destination(destination, chain);
				if (!parsed) {
					setError("Enter a valid address or BRC-42 counterparty public key.");
					return;
				}
				setReview({
					kind: "transfer",
					tokenId: normalizedTokenId,
					symbol,
					destination: parsed,
				});
				return;
			}
			if (
				isPermanentTermination(operation) &&
				!confirmsPermanentMintTermination(confirmation, normalizedTokenId)
			) {
				setError(
					`Type ${permanentMintTerminationConfirmation(normalizedTokenId)} exactly to continue.`,
				);
				return;
			}
			if (operation === "terminate-authority") {
				setReview({
					kind: operation,
					tokenId: normalizedTokenId,
					symbol,
				});
				return;
			}
			const atomic = parseBsv21Amount(amount, decimals);
			if (!atomic) {
				setError(
					`Enter a positive amount with at most ${decimals} decimal places.`,
				);
				return;
			}
			setReview({
				kind: operation,
				tokenId: normalizedTokenId,
				symbol,
				decimals,
				amount: atomic,
			});
		} catch (cause) {
			console.error(`[bsv21] authority review of ${tokenId} failed:`, cause);
			reportDiagnostic({
				category: "action",
				code: "action.failed",
				operation: `wallet.bsv21.authority.${operation}-review`,
				recoverable: true,
				context: { retryable: true },
			});
			setError(bsv21AuthorityFailureMessage(cause));
		} finally {
			setBusy(false);
		}
	}, [
		amount,
		chain,
		confirmation,
		destination,
		oneSatContext,
		operation,
		tokenId,
	]);

	const execute = useCallback(async () => {
		if (!(oneSatContext && review && bsv21Available)) return;
		setBusy(true);
		setError(null);
		try {
			if (
				review.kind !== operation ||
				review.tokenId !== normalizeBsv21TokenId(tokenId)
			) {
				setReview(null);
				throw new Error("Review details changed. Review the action again.");
			}
			if (
				review.kind === "transfer" &&
				JSON.stringify(parseBsv21Destination(destination, chain)) !==
					JSON.stringify(review.destination)
			) {
				setReview(null);
				throw new Error("Review details changed. Review the action again.");
			}
			if (
				isPermanentTermination(review.kind) &&
				!confirmsPermanentMintTermination(confirmation, review.tokenId)
			) {
				setReview(null);
				throw new Error("Review details changed. Review the action again.");
			}
			if (
				(review.kind === "mint" || review.kind === "terminate") &&
				parseBsv21Amount(amount, review.decimals) !== review.amount
			) {
				setReview(null);
				throw new Error("Review details changed. Review the action again.");
			}
			await prepareLiveBsv21AuthorityExecution(oneSatContext);
			let intent: Bsv21AuthorityIntent;
			if (review.kind === "terminate-authority") {
				intent = {
					kind: "terminate-authority",
					tokenId: review.tokenId,
				};
			} else if (review.kind === "terminate") {
				intent = {
					kind: "terminate",
					tokenId: review.tokenId,
					finalAmount: review.amount,
				};
			} else if (review.kind === "mint") {
				intent = {
					kind: "mint",
					tokenId: review.tokenId,
					amount: review.amount,
				};
			} else {
				intent = {
					kind: "transfer",
					tokenId: review.tokenId,
					destination: review.destination,
				};
			}
			const result = await executeBsv21AuthorityIntent(oneSatContext, intent);
			if (result.error) throw new Error(result.error);
			if (!result.txid) throw new Error(BSV21_ACTION_CONFIRMATION_MISSING);
			onDone(
				review.kind === "terminate-authority"
					? `Mint authority was permanently ended in ${result.txid}. No tokens were minted.`
					: review.kind === "terminate"
						? `Final mint submitted in ${result.txid}. Mint authority was permanently consumed.`
						: review.kind === "transfer"
							? `Minting was given away in ${result.txid}.`
							: `Minted ${formatBsv21Amount(review.amount, review.decimals)} ${review.symbol} in ${result.txid}. It shows once the overlay indexes it.`,
			);
			setReview(null);
			setOpen(false);
			play("success");
			refreshBalance();
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["wallet-balance"] }),
				queryClient.invalidateQueries({ queryKey: ["bsv21-market"] }),
			]);
			router.refresh();
		} catch (cause) {
			console.error(`[bsv21] authority ${review.kind} failed:`, cause);
			reportDiagnostic({
				category: "action",
				code: "action.failed",
				operation: `wallet.bsv21.authority.${review.kind}`,
				recoverable: !isPermanentTermination(review.kind),
				context: { retryable: !isPermanentTermination(review.kind) },
			});
			setError(bsv21AuthorityFailureMessage(cause));
			play("error");
		} finally {
			setBusy(false);
		}
	}, [
		amount,
		bsv21Available,
		chain,
		confirmation,
		destination,
		oneSatContext,
		onDone,
		operation,
		play,
		queryClient,
		refreshBalance,
		review,
		router,
		tokenId,
	]);

	const terminationPhrase = isBsv21TokenId(tokenId)
		? permanentMintTerminationConfirmation(tokenId)
		: "END <token ID>";
	const permanent = isPermanentTermination(review?.kind ?? operation);

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (busy) return;
				setOpen(next);
				if (!next) {
					setReview(null);
					setError(null);
				}
			}}
		>
			<DialogTrigger asChild>{trigger}</DialogTrigger>
			<DialogContent showCloseButton={!busy}>
				<DialogHeader>
					<DialogTitle>Mint BSV-21 tokens</DialogTitle>
					<DialogDescription>
						Uses this wallet's mint authority for the token. Your wallet asks
						you to approve.
					</DialogDescription>
				</DialogHeader>
				{review ? (
					<div className="flex flex-col gap-4">
						<Notice tone={permanent ? "danger" : "warning"}>
							{review.kind === "mint"
								? "A new mint authority returns to this wallet, so you can mint again later."
								: review.kind === "transfer"
									? "This wallet gives up its mint authority. The new holder controls all future minting."
									: review.kind === "terminate-authority"
										? "No tokens are minted, and no wallet can ever mint this token again."
										: "This is the last mint. No wallet can ever mint this token again."}
						</Notice>
						<DetailList className="rounded-xl border p-4">
							<DetailRow label="Action" mono={false}>
								{OPERATION_LABEL[review.kind]}
							</DetailRow>
							<DetailRow label="Token" stack>
								{review.symbol} · {review.tokenId}
							</DetailRow>
							{review.kind === "transfer" ? (
								<DetailRow label="New holder" stack>
									{review.destination.address ??
										review.destination.counterparty}
								</DetailRow>
							) : review.kind === "terminate-authority" ? null : (
								<DetailRow label="Amount">
									{formatBsv21Amount(review.amount, review.decimals)}
								</DetailRow>
							)}
						</DetailList>
					</div>
				) : (
					<div className="flex flex-col gap-4">
						<div className="flex flex-col gap-2">
							<Label htmlFor="bsv21-authority-operation">Action</Label>
							<Select
								value={operation}
								onValueChange={(value: AuthorityOperation) =>
									setOperation(value)
								}
							>
								<SelectTrigger
									className="w-full"
									id="bsv21-authority-operation"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{(Object.keys(OPERATION_LABEL) as AuthorityOperation[]).map(
										(value) => (
											<SelectItem key={value} value={value}>
												{OPERATION_LABEL[value]}
											</SelectItem>
										),
									)}
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-col gap-2">
							<Label htmlFor="bsv21-authority-token">Token ID</Label>
							<Input
								id="bsv21-authority-token"
								placeholder="txid_vout"
								readOnly={fixedTokenId !== undefined}
								value={tokenId}
								onChange={(event) => setTokenId(event.target.value)}
							/>
						</div>
						{operation === "transfer" ? (
							<div className="flex flex-col gap-2">
								<Label htmlFor="bsv21-authority-destination">New holder</Label>
								<Input
									id="bsv21-authority-destination"
									placeholder="Address or identity key"
									value={destination}
									onChange={(event) => setDestination(event.target.value)}
								/>
							</div>
						) : operation === "terminate-authority" ? null : (
							<div className="flex flex-col gap-2">
								<Label htmlFor="bsv21-authority-amount">
									{operation === "terminate" ? "Final amount" : "Amount"}
								</Label>
								<Input
									id="bsv21-authority-amount"
									inputMode="decimal"
									value={amount}
									onChange={(event) => setAmount(event.target.value)}
								/>
							</div>
						)}
						{isPermanentTermination(operation) ? (
							<div className="flex flex-col gap-2">
								<Notice tone="danger">
									This ends minting for good. It cannot be undone.
								</Notice>
								<Label htmlFor="bsv21-authority-confirm">
									Type {terminationPhrase} to confirm
								</Label>
								<Input
									autoComplete="off"
									id="bsv21-authority-confirm"
									value={confirmation}
									onChange={(event) => setConfirmation(event.target.value)}
								/>
							</div>
						) : null}
					</div>
				)}
				{error ? (
					<p className="text-destructive text-sm" role="alert">
						{error}
					</p>
				) : null}
				<DialogFooter>
					<Button
						disabled={busy}
						onClick={() => (review ? setReview(null) : setOpen(false))}
						type="button"
						variant="outline"
					>
						{review ? "Edit" : "Cancel"}
					</Button>
					<Button
						disabled={busy || !(oneSatContext && bsv21Available)}
						onClick={() => void (review ? execute() : prepareReview())}
						type="button"
						variant={review && permanent ? "destructive" : "default"}
					>
						{busy ? (
							<Loader2 className="animate-spin" data-icon="inline-start" />
						) : null}
						{review
							? review.kind === "mint" || review.kind === "terminate"
								? "Mint"
								: review.kind === "transfer"
									? "Give minting away"
									: "End minting"
							: "Review"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
