"use client";

import { deployBsv21Mint } from "@1sat/actions";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Plus } from "lucide-react";
import Link from "next/link";
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
import { useStackFeatures } from "@/lib/hooks/use-stack-features";
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
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import { Bsv21AuthorityManager } from "./bsv21-authority-manager";

const VALID_SYMBOL = /^[^\p{Cc}\p{Cs}]{1,32}$/u;

type DeploymentReview =
	| { kind: "fixed"; symbol: string; decimals: number; amount: bigint }
	| { kind: "authority"; symbol: string; decimals: number };

export function Bsv21Deploy() {
	const router = useRouter();
	const queryClient = useQueryClient();
	const { play } = useSound();
	const { oneSatContext, refreshBalance } = useWalletToolbox();
	const features = useStackFeatures();
	const [open, setOpen] = useState(false);
	const [createMode, setCreateMode] = useState<"fixed" | "authority">("fixed");
	const [symbol, setSymbol] = useState("");
	const [amount, setAmount] = useState("");
	const [decimalsText, setDecimalsText] = useState("0");
	const [review, setReview] = useState<DeploymentReview | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [createdTokenId, setCreatedTokenId] = useState<string | null>(null);
	const [createdAuthorityTokenId, setCreatedAuthorityTokenId] = useState<
		string | null
	>(null);
	const bsv21Available = features.data?.features.bsv21 === true;
	const decimals = /^\d+$/.test(decimalsText)
		? Number.parseInt(decimalsText, 10)
		: Number.NaN;

	const prepareReview = useCallback(() => {
		setError(null);
		const normalizedSymbol = symbol.trim();
		if (!VALID_SYMBOL.test(normalizedSymbol)) {
			setError("Enter a printable symbol between 1 and 32 characters.");
			return;
		}
		if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
			setError("Decimals must be a whole number from 0 through 18.");
			return;
		}
		if (createMode === "authority") {
			setReview({ kind: "authority", symbol: normalizedSymbol, decimals });
			return;
		}
		const atomic = parseBsv21Amount(amount, decimals);
		if (!atomic) {
			setError(
				`Enter a positive fixed supply with at most ${decimals} decimals.`,
			);
			return;
		}
		setReview({
			kind: "fixed",
			symbol: normalizedSymbol,
			decimals,
			amount: atomic,
		});
	}, [amount, createMode, decimals, symbol]);

	const deploy = useCallback(async () => {
		if (!(oneSatContext && review && bsv21Available)) return;
		setBusy(true);
		setError(null);
		try {
			const normalizedSymbol = symbol.trim();
			const atomic =
				review.kind === "fixed" ? parseBsv21Amount(amount, decimals) : null;
			if (
				review.kind !== createMode ||
				review.symbol !== normalizedSymbol ||
				review.decimals !== decimals ||
				!VALID_SYMBOL.test(normalizedSymbol) ||
				!Number.isInteger(decimals) ||
				(review.kind === "fixed" && atomic !== review.amount)
			) {
				setReview(null);
				throw new Error("Review details changed. Review the deployment again.");
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
			setCreatedTokenId(result.tokenId ?? null);
			setCreatedAuthorityTokenId(
				review.kind === "authority" ? (result.tokenId ?? null) : null,
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
		amount,
		bsv21Available,
		createMode,
		decimals,
		oneSatContext,
		play,
		queryClient,
		refreshBalance,
		review,
		router,
		symbol,
	]);

	return (
		<section
			aria-labelledby="deploy-bsv21-title"
			className="space-y-4 rounded-lg border p-4"
		>
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div>
					<h2 id="deploy-bsv21-title" className="text-lg font-semibold">
						Create a BSV21 token
					</h2>
					<p className="text-sm text-muted-foreground">
						Deploy a permanently fixed supply or a controlled mint authority
						through canonical wallet actions.
					</p>
				</div>
				<Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
					<DialogTrigger asChild>
						<Button disabled={!oneSatContext || !bsv21Available}>
							<Plus className="mr-2 size-4" /> Deploy token
						</Button>
					</DialogTrigger>
					<DialogContent showCloseButton={!busy}>
						<DialogHeader>
							<DialogTitle>Deploy BSV21 token</DialogTitle>
							<DialogDescription>
								Choose a permanently fixed supply or a controlled mint
								authority. Deployment is irreversible.
							</DialogDescription>
						</DialogHeader>
						{review ? (
							<div className="space-y-4">
								<dl className="grid grid-cols-[auto_1fr] gap-2 rounded-md border p-3 text-sm">
									<dt>Symbol</dt>
									<dd className="text-right font-mono">{review.symbol}</dd>
									<dt>Supply model</dt>
									<dd className="text-right">
										{review.kind === "fixed" ? "Fixed" : "Mint authority"}
									</dd>
									{review.kind === "fixed" ? (
										<>
											<dt>Supply</dt>
											<dd className="break-all text-right font-mono">
												{formatBsv21Amount(review.amount, review.decimals)}
											</dd>
											<dt>Atomic supply</dt>
											<dd className="break-all text-right font-mono">
												{review.amount.toString()}
											</dd>
										</>
									) : null}
									<dt>Decimals</dt>
									<dd className="text-right font-mono">{review.decimals}</dd>
									<dt>Token output</dt>
									<dd className="text-right font-mono">1 sat</dd>
									<dt>Network fee</dt>
									<dd className="text-right text-muted-foreground">
										Set by the wallet; not quoted here
									</dd>
								</dl>
								<div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
									<AlertTriangle className="mt-0.5 size-4 shrink-0" />
									<p>
										{review.kind === "fixed"
											? "This creates the entire supply permanently. There is no mint authority or undo action."
											: "This creates zero supply and one mint authority controlled by this wallet. Anyone controlling that authority can mint or transfer it."}
									</p>
								</div>
							</div>
						) : (
							<div className="space-y-4">
								<div className="space-y-2">
									<Label htmlFor="bsv21-supply-model">Supply model</Label>
									<Select
										value={createMode}
										onValueChange={(value: "fixed" | "authority") =>
											setCreateMode(value)
										}
									>
										<SelectTrigger id="bsv21-supply-model">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="fixed">Fixed supply</SelectItem>
											<SelectItem value="authority">Mint authority</SelectItem>
										</SelectContent>
									</Select>
								</div>
								<div className="space-y-2">
									<Label htmlFor="bsv21-symbol">Symbol</Label>
									<Input
										id="bsv21-symbol"
										maxLength={32}
										value={symbol}
										onChange={(event) => setSymbol(event.target.value)}
									/>
								</div>
								<div className="space-y-2">
									<Label htmlFor="bsv21-decimals">Decimals</Label>
									<Input
										id="bsv21-decimals"
										inputMode="numeric"
										value={decimalsText}
										onChange={(event) => setDecimalsText(event.target.value)}
									/>
								</div>
								{createMode === "fixed" ? (
									<div className="space-y-2">
										<Label htmlFor="bsv21-supply">Fixed supply</Label>
										<Input
											id="bsv21-supply"
											inputMode="decimal"
											value={amount}
											onChange={(event) => setAmount(event.target.value)}
										/>
									</div>
								) : (
									<p className="text-sm text-muted-foreground">
										Initial supply is zero. Mint only after the deployment is
										indexed by the BSV21 overlay.
									</p>
								)}
							</div>
						)}
						{error ? (
							<p className="text-sm text-destructive" role="alert">
								{error}
							</p>
						) : null}
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								disabled={busy}
								onClick={() => (review ? setReview(null) : setOpen(false))}
							>
								{review ? "Edit" : "Cancel"}
							</Button>
							<Button
								type="button"
								disabled={busy}
								onClick={() => void (review ? deploy() : prepareReview())}
							>
								{busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
								{review
									? "Authorize irreversible deployment"
									: "Review deployment"}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</div>
			{createdTokenId ? (
				<p className="text-sm text-primary" role="status">
					Deployment submitted. Indexing is not yet confirmed.{" "}
					<Link className="underline" href={`/market/bsv21/${createdTokenId}`}>
						Open token {createdTokenId}
					</Link>
				</p>
			) : null}
			{!bsv21Available ? (
				<p className="text-sm text-destructive" role="status">
					Token deployment and authority actions are disabled until the
					configured stack advertises BSV21.
				</p>
			) : null}
			<Bsv21AuthorityManager
				key={createdAuthorityTokenId ?? "authority-manager"}
				bsv21Available={bsv21Available}
				suggestedTokenId={createdAuthorityTokenId}
			/>
		</section>
	);
}
