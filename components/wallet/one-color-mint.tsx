"use client";

import { AlertTriangle, Copy, Loader2, Sparkles } from "lucide-react";
import { useCallback, useRef, useState } from "react";
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
import { Switch } from "@/components/ui/switch";
import { useCopyWithSound } from "@/hooks/use-copy-with-sound";
import { useSound } from "@/hooks/use-sound";
import { isOneColorAvailable } from "@/lib/chain-endpoints";
import { permanentMintTerminationConfirmation } from "@/lib/wallet/bsv21-authority";
import { type OneColorBalance, oneColorTicker } from "@/lib/wallet/one-color";
import {
	formatOneColorAmount,
	type OneColorMintInput,
	prepareOneColorMint,
	runOneColorMint,
} from "@/lib/wallet/one-color-actions";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import {
	FOOTER_BUTTON_CLASS,
	logOneColorFailure,
	useRefreshAfterWrite,
} from "./one-color-send";

const END_MINTING_WARNING =
	"This cannot be undone. No more of this token can ever be minted from this wallet's mint authority.";

function mintedMessage(
	amount: bigint,
	endedMinting: boolean,
	token: OneColorBalance,
): string {
	if (amount === 0n) return "Minting has ended. No tokens were minted.";
	const minted = `Minted ${formatOneColorAmount(amount, token.dec)} ${oneColorTicker(token)}.`;
	return endedMinting ? `${minted} Minting has ended.` : minted;
}

/**
 * Mint 1Color tokens to this wallet from a mint authority it holds, keeping
 * the authority or ending minting. Testnet only; writes through
 * `colorContext`. The trigger shows while the wallet holds an authority; an
 * open dialog stays mounted after its authority is spent. Every outcome also
 * goes to the page (`onMinted`, `onFailed`): the re-read after a mint that
 * ended minting can drop a zero-balance token from the holdings, and the
 * page unmounts this dialog while it reloads the token.
 */
export function OneColorMintDialog({
	token,
	onStart,
	onMinted,
	onFailed,
}: {
	token: OneColorBalance;
	/** A mint is starting: earlier results on the page no longer apply. */
	onStart: () => void;
	/** The mint went through; the message says what it did. */
	onMinted: (message: string) => void;
	/** The mint failed; the message is the one the dialog shows. */
	onFailed: (message: string) => void;
}) {
	const { play } = useSound();
	const [, copy] = useCopyWithSound();
	const { chain, colorContext } = useWalletToolbox();
	const refreshAfterWrite = useRefreshAfterWrite();
	const ticker = oneColorTicker(token);
	const phrase = permanentMintTerminationConfirmation(token.assetId);
	const [open, setOpen] = useState(false);
	const [amount, setAmount] = useState("");
	const [endMinting, setEndMinting] = useState(false);
	const [confirmation, setConfirmation] = useState("");
	const [review, setReview] = useState<OneColorMintInput | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Set before the first await, so a second tap in the same frame is ignored.
	const inFlight = useRef(false);

	const resetForm = useCallback(() => {
		setAmount("");
		setEndMinting(false);
		setConfirmation("");
		setReview(null);
		setError(null);
	}, []);

	const changeOpen = useCallback(
		(next: boolean) => {
			if (busy) return;
			setOpen(next);
			if (!next) resetForm();
		},
		[busy, resetForm],
	);

	const changeEndMinting = useCallback((next: boolean) => {
		setEndMinting(next);
		setConfirmation("");
		setError(null);
	}, []);

	const prepareReview = useCallback(() => {
		setError(null);
		const prepared = prepareOneColorMint(
			{ amount, endMinting, confirmation },
			token,
		);
		if (prepared.ok) setReview(prepared.input);
		else setError(prepared.error);
	}, [amount, confirmation, endMinting, token]);

	const mint = useCallback(async () => {
		if (!(colorContext && review) || inFlight.current) return;
		inFlight.current = true;
		setBusy(true);
		setError(null);
		onStart();
		// Holdings are re-read before `busy` clears, so Mint stays disabled
		// until the wallet's own read shows whether the mint landed.
		const outcome = await runOneColorMint(colorContext, review, {
			log: logOneColorFailure,
			refresh: refreshAfterWrite,
		});
		if (outcome.ok) {
			setOpen(false);
			resetForm();
			onMinted(mintedMessage(review.amount, outcome.endedMinting, token));
			play("success");
		} else {
			// A mint that may have gone out is never left a tap away from a
			// second one: the review is cleared and the form starts over.
			if (outcome.mayHaveBeenSent) resetForm();
			setError(outcome.message);
			onFailed(outcome.message);
			play("error");
		}
		setBusy(false);
		inFlight.current = false;
	}, [
		colorContext,
		onFailed,
		onMinted,
		onStart,
		play,
		refreshAfterWrite,
		resetForm,
		review,
		token,
	]);

	if (!(isOneColorAvailable(chain) && colorContext)) return null;
	if (token.authorities <= 0 && !open) return null;

	const confirmLabel = !review
		? "Review mint"
		: review.amount === 0n
			? "End minting"
			: review.endMinting
				? "Mint and end minting"
				: "Mint";

	return (
		<Dialog open={open} onOpenChange={changeOpen}>
			<DialogTrigger asChild>
				<Button size="sm" variant="outline" disabled={token.authorities <= 0}>
					<Sparkles className="size-4" data-icon="inline-start" /> Mint
				</Button>
			</DialogTrigger>
			<DialogContent showCloseButton={!busy}>
				<DialogHeader>
					<DialogTitle>Mint {ticker}</DialogTitle>
					<DialogDescription>
						Mints new tokens to this wallet with its mint authority.
					</DialogDescription>
				</DialogHeader>
				{review ? (
					<div className="space-y-4">
						<dl className="grid grid-cols-[auto_1fr] gap-2 rounded-md border p-3 text-sm">
							<dt className="text-muted-foreground">Amount</dt>
							<dd className="break-all text-right font-mono">
								{review.amount === 0n
									? "None"
									: `${formatOneColorAmount(review.amount, token.dec)} ${ticker}`}
							</dd>
							<dt className="text-muted-foreground">Minted to</dt>
							<dd className="text-right">This wallet</dd>
							<dt className="text-muted-foreground">Keeps mint authority</dt>
							<dd className="text-right">
								{review.endMinting ? "No, minting ends" : "Yes"}
							</dd>
							<dt className="text-muted-foreground">Token outputs</dt>
							<dd className="text-right font-mono">1 sat each</dd>
							<dt className="text-muted-foreground">Network fee</dt>
							<dd className="text-right text-muted-foreground">
								Set by the wallet
							</dd>
						</dl>
						{review.endMinting ? (
							<div className="flex gap-2 rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
								<AlertTriangle className="mt-0.5 size-4 shrink-0" />
								<p>{END_MINTING_WARNING}</p>
							</div>
						) : (
							<p className="text-sm text-muted-foreground">
								A new mint authority returns to this wallet, so it can mint
								again later.
							</p>
						)}
					</div>
				) : (
					<div className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="one-color-mint-amount">
								Amount{endMinting ? " (optional)" : ""}
							</Label>
							<Input
								id="one-color-mint-amount"
								inputMode="decimal"
								placeholder="0"
								value={amount}
								onChange={(event) => setAmount(event.target.value)}
							/>
							<p className="text-xs text-muted-foreground">
								{endMinting
									? `Leave empty to end minting without minting any ${ticker}.`
									: `In ${ticker}, up to ${token.dec} decimals.`}
							</p>
						</div>
						<div className="flex items-start gap-3">
							<Switch
								id="one-color-mint-end"
								className="mt-0.5"
								checked={endMinting}
								onCheckedChange={changeEndMinting}
							/>
							<div className="space-y-1">
								<Label htmlFor="one-color-mint-end">End minting</Label>
								<p className="text-xs text-muted-foreground">
									{endMinting
										? "This wallet gives up its mint authority after this."
										: "Off: this wallet keeps its mint authority and can mint again later."}
								</p>
							</div>
						</div>
						{endMinting ? (
							<div className="space-y-2 rounded-md border border-destructive bg-destructive/10 p-3">
								<p className="text-sm text-destructive">
									{END_MINTING_WARNING}
								</p>
								<div className="flex items-start gap-1">
									<Label
										className="min-w-0 flex-1 text-destructive"
										htmlFor="one-color-mint-confirm"
									>
										<span className="min-w-0 break-all">
											Type {phrase} to confirm
										</span>
									</Label>
									<Button
										type="button"
										aria-label="Copy confirmation phrase"
										title="Copy confirmation phrase"
										onClick={() => void copy(phrase)}
										size="icon"
										variant="ghost"
										className="shrink-0 text-destructive"
									>
										<Copy />
									</Button>
								</div>
								<Input
									id="one-color-mint-confirm"
									autoCapitalize="none"
									autoComplete="off"
									autoCorrect="off"
									spellCheck={false}
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
						type="button"
						variant="outline"
						className={FOOTER_BUTTON_CLASS}
						disabled={busy}
						onClick={() => (review ? setReview(null) : changeOpen(false))}
					>
						{review ? "Edit" : "Cancel"}
					</Button>
					<Button
						type="button"
						variant={review?.endMinting ? "destructive" : "default"}
						className={FOOTER_BUTTON_CLASS}
						disabled={
							busy ||
							token.authorities <= 0 ||
							(!review && !(amount.trim() || endMinting))
						}
						onClick={() => void (review ? mint() : prepareReview())}
					>
						{busy ? (
							<Loader2
								className="size-4 animate-spin"
								data-icon="inline-start"
							/>
						) : null}
						{confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
