"use client";

import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, KeyRound, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useSound } from "@/hooks/use-sound";
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

type AuthorityOperation = "mint" | "transfer" | "terminate";
type AuthorityReview =
	| {
			kind: "mint";
			tokenId: string;
			symbol: string;
			decimals: number;
			amount: bigint;
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

export function Bsv21AuthorityManager({
	bsv21Available,
	suggestedTokenId,
}: {
	bsv21Available: boolean;
	suggestedTokenId: string | null;
}) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const { play } = useSound();
	const { chain, oneSatContext, refreshBalance } = useWalletToolbox();
	const [open, setOpen] = useState(false);
	const [operation, setOperation] = useState<AuthorityOperation>("mint");
	const [tokenId, setTokenId] = useState(suggestedTokenId ?? "");
	const [amount, setAmount] = useState("");
	const [destination, setDestination] = useState("");
	const [confirmation, setConfirmation] = useState("");
	const [review, setReview] = useState<AuthorityReview | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [status, setStatus] = useState<string | null>(null);

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
			const atomic = parseBsv21Amount(amount, decimals);
			if (!atomic) {
				setError(
					`Enter a positive amount with at most ${decimals} decimal places.`,
				);
				return;
			}
			if (
				operation === "terminate" &&
				!confirmsPermanentMintTermination(confirmation, normalizedTokenId)
			) {
				setError(
					`Type ${permanentMintTerminationConfirmation(normalizedTokenId)} exactly to continue.`,
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
				review.kind !== "transfer" &&
				(parseBsv21Amount(amount, review.decimals) !== review.amount ||
					(review.kind === "terminate" &&
						!confirmsPermanentMintTermination(confirmation, review.tokenId)))
			) {
				setReview(null);
				throw new Error("Review details changed. Review the action again.");
			}
			await prepareLiveBsv21AuthorityExecution(oneSatContext);
			let intent: Bsv21AuthorityIntent;
			if (review.kind === "terminate") {
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
			setStatus(
				review.kind === "terminate"
					? `Final mint submitted in ${result.txid ?? "the wallet"}. Mint authority was permanently consumed.`
					: `Authority action submitted in ${result.txid ?? "the wallet"}. Overlay indexing is not yet confirmed.`,
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
			reportDiagnostic({
				category: "action",
				code: "action.failed",
				operation: `wallet.bsv21.authority.${review.kind}`,
				recoverable: review.kind !== "terminate",
				context: { retryable: review.kind !== "terminate" },
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
		: "END <canonical token ID>";

	return (
		<div className="space-y-3 border-t pt-4">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div>
					<h3 className="font-medium">Mint authority</h3>
					<p className="text-sm text-muted-foreground">
						Mint supply, transfer control, or permanently end minting with a
						final mint.
					</p>
				</div>
				<Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
					<DialogTrigger asChild>
						<Button
							disabled={!oneSatContext || !bsv21Available}
							variant="outline"
						>
							<KeyRound className="mr-2 size-4" /> Manage authority
						</Button>
					</DialogTrigger>
					<DialogContent showCloseButton={!busy}>
						<DialogHeader>
							<DialogTitle>Manage BSV21 mint authority</DialogTitle>
							<DialogDescription>
								The wallet action selects the matching authority from the
								standard bsv21 basket and requests wallet approval.
							</DialogDescription>
						</DialogHeader>
						{review ? (
							<div className="space-y-4">
								<dl className="grid grid-cols-[auto_1fr] gap-2 rounded-md border p-3 text-sm">
									<dt>Action</dt>
									<dd className="text-right font-medium">
										{review.kind === "mint"
											? "Mint and continue authority"
											: review.kind === "transfer"
												? "Transfer authority only"
												: "Final mint and end authority"}
									</dd>
									<dt>Token</dt>
									<dd className="break-all text-right font-mono">
										{review.symbol} · {review.tokenId}
									</dd>
									{review.kind === "transfer" ? (
										<>
											<dt>New controller</dt>
											<dd className="break-all text-right font-mono">
												{review.destination.address ??
													review.destination.counterparty}
											</dd>
										</>
									) : (
										<>
											<dt>Amount</dt>
											<dd className="break-all text-right font-mono">
												{formatBsv21Amount(review.amount, review.decimals)}
											</dd>
											<dt>Atomic amount</dt>
											<dd className="break-all text-right font-mono">
												{review.amount.toString()}
											</dd>
										</>
									)}
								</dl>
								<div
									className={`flex gap-2 rounded-md border p-3 text-sm ${
										review.kind === "terminate"
											? "border-destructive bg-destructive/10 text-destructive"
											: "border-amber-500/40 bg-amber-500/5"
									}`}
								>
									<AlertTriangle className="mt-0.5 size-4 shrink-0" />
									<p>
										{review.kind === "mint"
											? "A replacement authority returns to this wallet so future minting remains possible."
											: review.kind === "transfer"
												? "This wallet gives up its authority. The recipient controls all future minting."
												: "This mints the final amount and emits no replacement authority. No wallet can ever mint this token again."}
									</p>
								</div>
							</div>
						) : (
							<div className="space-y-4">
								<div className="space-y-2">
									<Label htmlFor="bsv21-authority-operation">Action</Label>
									<Select
										value={operation}
										onValueChange={(value: AuthorityOperation) =>
											setOperation(value)
										}
									>
										<SelectTrigger id="bsv21-authority-operation">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="mint">
												Mint and keep authority
											</SelectItem>
											<SelectItem value="transfer">
												Transfer authority only
											</SelectItem>
											<SelectItem value="terminate">
												Final mint and permanently end
											</SelectItem>
										</SelectContent>
									</Select>
								</div>
								<div className="space-y-2">
									<Label htmlFor="bsv21-authority-token">Token ID</Label>
									<Input
										id="bsv21-authority-token"
										placeholder="txid_vout"
										value={tokenId}
										onChange={(event) => setTokenId(event.target.value)}
									/>
								</div>
								{operation === "transfer" ? (
									<div className="space-y-2">
										<Label htmlFor="bsv21-authority-destination">
											New controller
										</Label>
										<Input
											id="bsv21-authority-destination"
											placeholder="Address or public key"
											value={destination}
											onChange={(event) => setDestination(event.target.value)}
										/>
									</div>
								) : (
									<div className="space-y-2">
										<Label htmlFor="bsv21-authority-amount">
											{operation === "terminate"
												? "Final mint amount"
												: "Mint amount"}
										</Label>
										<Input
											id="bsv21-authority-amount"
											inputMode="decimal"
											value={amount}
											onChange={(event) => setAmount(event.target.value)}
										/>
									</div>
								)}
								{operation === "terminate" ? (
									<div className="space-y-2 rounded-md border border-destructive bg-destructive/10 p-3">
										<p className="text-sm text-destructive">
											Authority-only termination is unavailable in @1sat/actions
											0.0.202. This supported path requires a final positive
											mint.
										</p>
										<Label
											className="text-destructive"
											htmlFor="bsv21-authority-confirm"
										>
											Type {terminationPhrase} to confirm permanent termination
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
							<p className="text-sm text-destructive" role="alert">
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
								disabled={busy}
								onClick={() => void (review ? execute() : prepareReview())}
								type="button"
								variant={
									review?.kind === "terminate" ? "destructive" : "default"
								}
							>
								{busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
								{review
									? "Authorize reviewed action"
									: "Review authority action"}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</div>
			{status ? (
				<p className="text-sm text-primary" role="status">
					{status}
				</p>
			) : null}
		</div>
	);
}
