"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, Send } from "lucide-react";
import { useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
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
import { useOneColorPending } from "@/hooks/use-one-color-pending";
import { useSound } from "@/hooks/use-sound";
import { isOneColorAvailable } from "@/lib/chain-endpoints";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import { type OneColorBalance, oneColorTicker } from "@/lib/wallet/one-color";
import {
	formatOneColorAmount,
	normalizeHandle,
	ONE_COLOR_HANDLE_PROMPT,
	type OneColorPendingSend,
	type OneColorSendInput,
	type OneColorSendOutcome,
	oneColorSendAmountError,
	parseOneColorAmount,
	runOneColorCancel,
	runOneColorSend,
} from "@/lib/wallet/one-color-actions";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

/** Bottom sheet on phones: scrolls inside the viewport, full-width buttons. */
const SHEET_CLASS = "max-h-[calc(100dvh-2rem)] overflow-y-auto";
const FOOTER_BUTTON_CLASS = "w-full sm:w-auto";

const DELIVERY_NOTE =
	"Delivered to the handle's mailbox and claimed when their wallet next syncs.";

function logSendFailure(
	operation: string,
	cause: unknown,
	details?: { txid?: string },
) {
	console.error(
		`[1color] ${operation} failed${details?.txid ? ` (txid ${details.txid})` : ""}:`,
		cause,
	);
	reportDiagnostic({
		category: "action",
		code: "action.failed",
		operation: `wallet.1color.${operation}`,
		recoverable: true,
		context: { retryable: true },
	});
}

/** Re-reads holdings, history and pending sends (all under `["one-color"]`). */
function useOneColorRefresh() {
	const queryClient = useQueryClient();
	return useCallback(
		() => queryClient.invalidateQueries({ queryKey: ["one-color"] }),
		[queryClient],
	);
}

const shortTxid = (txid: string) => `${txid.slice(0, 8)}…${txid.slice(-8)}`;

/** Send 1Color tokens to a handle. Testnet only; writes through `colorContext`. */
export function OneColorSendDialog({
	token,
	onOutcome,
}: {
	token: OneColorBalance;
	/** A send that reached the wallet: sent, or built but not delivered. */
	onOutcome: (
		outcome: Exclude<OneColorSendOutcome, { kind: "failed" }>,
	) => void;
}) {
	const { play } = useSound();
	const { chain, colorContext, refreshBalance } = useWalletToolbox();
	const refreshOneColor = useOneColorRefresh();
	const ticker = oneColorTicker(token);
	const [open, setOpen] = useState(false);
	const [handle, setHandle] = useState("");
	const [amount, setAmount] = useState("");
	const [memo, setMemo] = useState("");
	const [review, setReview] = useState<OneColorSendInput | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const resetForm = useCallback(() => {
		setHandle("");
		setAmount("");
		setMemo("");
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

	const prepareReview = useCallback(() => {
		setError(null);
		const normalized = normalizeHandle(handle);
		if (!normalized) {
			setError(ONE_COLOR_HANDLE_PROMPT);
			return;
		}
		const amountError = oneColorSendAmountError(
			amount,
			token.dec,
			token.available,
		);
		const atomic = parseOneColorAmount(amount, token.dec);
		if (amountError || atomic === null) {
			setError(amountError ?? "Enter a valid amount.");
			return;
		}
		const trimmedMemo = memo.trim();
		setReview({
			assetId: token.assetId,
			amount: atomic,
			handle: normalized,
			...(trimmedMemo ? { memo: trimmedMemo } : {}),
		});
	}, [amount, handle, memo, token.assetId, token.available, token.dec]);

	const send = useCallback(async () => {
		if (!(colorContext && review)) return;
		setBusy(true);
		setError(null);
		// Holdings are re-read before `busy` clears, so Send stays disabled until
		// the wallet's own read shows whether a send was built.
		const outcome = await runOneColorSend(colorContext, review, {
			log: logSendFailure,
			refresh: async () => {
				refreshBalance();
				await refreshOneColor();
			},
		});
		if (outcome.kind === "failed") {
			// A send that may have been built is never left one tap away from a
			// second one: back to the form, and the pending list shows it.
			if (outcome.mayHaveBeenBuilt) setReview(null);
			setError(outcome.message);
			play("error");
		} else {
			setOpen(false);
			resetForm();
			onOutcome(outcome);
			play(outcome.kind === "sent" ? "success" : "error");
		}
		setBusy(false);
	}, [
		colorContext,
		onOutcome,
		play,
		refreshBalance,
		refreshOneColor,
		resetForm,
		review,
	]);

	const usable = isOneColorAvailable(chain) && colorContext !== null;

	return (
		<Dialog open={open} onOpenChange={changeOpen}>
			<DialogTrigger asChild>
				<Button
					size="sm"
					variant="outline"
					disabled={!usable || token.available <= 0n}
				>
					<Send className="size-4" data-icon="inline-start" /> Send
				</Button>
			</DialogTrigger>
			<DialogContent className={SHEET_CLASS} showCloseButton={!busy}>
				<DialogHeader>
					<DialogTitle>Send {ticker}</DialogTitle>
					<DialogDescription>
						1Color tokens are sent to a handle, not to an address.
					</DialogDescription>
				</DialogHeader>
				{review ? (
					<div className="space-y-4">
						<dl className="grid grid-cols-[auto_1fr] gap-2 rounded-md border p-3 text-sm">
							<dt className="text-muted-foreground">To</dt>
							<dd className="break-all text-right font-mono">
								{review.handle}
							</dd>
							<dt className="text-muted-foreground">Amount</dt>
							<dd className="break-all text-right font-mono">
								{formatOneColorAmount(review.amount, token.dec)} {ticker}
							</dd>
							{review.memo ? (
								<>
									<dt className="text-muted-foreground">Memo</dt>
									<dd className="break-all text-right">{review.memo}</dd>
								</>
							) : null}
							<dt className="text-muted-foreground">Network fee</dt>
							<dd className="text-right text-muted-foreground">
								Set by the wallet
							</dd>
						</dl>
						<p className="text-sm text-muted-foreground">
							Check the amount and recipient. {DELIVERY_NOTE}
						</p>
					</div>
				) : (
					<div className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="one-color-send-handle">Handle</Label>
							<Input
								id="one-color-send-handle"
								autoCapitalize="none"
								autoComplete="off"
								autoCorrect="off"
								spellCheck={false}
								placeholder="@name@domain"
								value={handle}
								onChange={(event) => setHandle(event.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="one-color-send-amount">Amount</Label>
							<div className="flex gap-2">
								<Input
									id="one-color-send-amount"
									inputMode="decimal"
									placeholder="0"
									value={amount}
									onChange={(event) => setAmount(event.target.value)}
								/>
								<Button
									type="button"
									variant="outline"
									className="shrink-0"
									onClick={() =>
										setAmount(formatOneColorAmount(token.available, token.dec))
									}
								>
									Max
								</Button>
							</div>
							<p className="text-xs text-muted-foreground">
								Available: {formatOneColorAmount(token.available, token.dec)}{" "}
								{ticker}
							</p>
						</div>
						<div className="space-y-2">
							<Label htmlFor="one-color-send-memo">Memo (optional)</Label>
							<Input
								id="one-color-send-memo"
								maxLength={2000}
								value={memo}
								onChange={(event) => setMemo(event.target.value)}
							/>
						</div>
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
						className={FOOTER_BUTTON_CLASS}
						disabled={busy || (!review && !(handle.trim() && amount.trim()))}
						onClick={() => void (review ? send() : prepareReview())}
					>
						{busy ? (
							<Loader2
								className="size-4 animate-spin"
								data-icon="inline-start"
							/>
						) : null}
						{review ? "Send" : "Review send"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function CancelSendDialog({
	send,
	label,
	onRequested,
	onRefused,
}: {
	send: OneColorPendingSend;
	/** The amount and recipient, for the confirmation. */
	label: string;
	onRequested: (message: string) => void;
	onRefused: (message: string) => void;
}) {
	const { play } = useSound();
	const { colorContext } = useWalletToolbox();
	const refreshOneColor = useOneColorRefresh();
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const changeOpen = (next: boolean) => {
		if (busy) return;
		setOpen(next);
		if (!next) setError(null);
	};

	const cancel = async () => {
		if (!colorContext) return;
		setBusy(true);
		setError(null);
		const outcome = await runOneColorCancel(colorContext, send, {
			log: logSendFailure,
			refresh: refreshOneColor,
		});
		if (outcome.kind === "failed") {
			setError(outcome.message);
			play("error");
		} else {
			setOpen(false);
			if (outcome.kind === "requested") {
				onRequested(outcome.message);
				play("success");
			} else {
				onRefused(outcome.message);
				play("error");
			}
		}
		setBusy(false);
	};

	return (
		<Dialog open={open} onOpenChange={changeOpen}>
			<DialogTrigger asChild>
				<Button size="sm" variant="outline" disabled={!colorContext}>
					Cancel
				</Button>
			</DialogTrigger>
			<DialogContent className={SHEET_CLASS} showCloseButton={!busy}>
				<DialogHeader>
					<DialogTitle>Cancel this send?</DialogTitle>
					<DialogDescription>
						{label}. The wallet asks the network for the tokens back. If the
						recipient claims them first, they keep them.
					</DialogDescription>
				</DialogHeader>
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
						onClick={() => changeOpen(false)}
					>
						Keep send
					</Button>
					<Button
						type="button"
						variant="destructive"
						className={FOOTER_BUTTON_CLASS}
						disabled={busy}
						onClick={() => void cancel()}
					>
						{busy ? (
							<Loader2
								className="size-4 animate-spin"
								data-icon="inline-start"
							/>
						) : null}
						Cancel send
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/**
 * The asset's sends still waiting to be claimed (`nosend` handoffs), each
 * with Cancel. Shown only when there is something to show.
 */
export function OneColorPendingSends({
	token,
	undelivered,
}: {
	token: OneColorBalance;
	/** Sends built in this session whose delivery failed. */
	undelivered: ReadonlySet<string>;
}) {
	const { colorContext } = useWalletToolbox();
	const pending = useOneColorPending(token.assetId);
	const [cancelRequested, setCancelRequested] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const [notice, setNotice] = useState<string | null>(null);
	const ticker = oneColorTicker(token);

	if (!colorContext || pending.isPending) return null;

	if (pending.isError) {
		return (
			<section aria-labelledby="one-color-pending" className="space-y-3">
				<h2 id="one-color-pending" className="text-lg font-medium">
					Waiting to be claimed
				</h2>
				<div
					role="alert"
					className="flex flex-wrap items-center gap-3 text-sm text-destructive"
				>
					<span>Couldn't load sends waiting to be claimed.</span>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => void pending.refetch()}
					>
						<RefreshCw data-icon="inline-start" /> Retry
					</Button>
				</div>
			</section>
		);
	}

	const { sends } = pending.data;
	if (sends.length === 0 && !notice) return null;

	return (
		<section aria-labelledby="one-color-pending" className="space-y-3">
			<div className="space-y-1">
				<h2 id="one-color-pending" className="text-lg font-medium">
					Waiting to be claimed
				</h2>
				<p className="text-sm text-muted-foreground">
					Sent, but not yet claimed by the recipient. You can cancel a send
					until it's claimed.
				</p>
			</div>
			{notice ? (
				<p className="text-sm" role="status">
					{notice}
				</p>
			) : null}
			{sends.length > 0 ? (
				<ul className="flex flex-col divide-y divide-border/60">
					{sends.map((send) => {
						const amountText =
							send.amount === null
								? "Amount unknown"
								: `${formatOneColorAmount(send.amount, token.dec)} ${ticker}`;
						const to = send.handle ?? "an unknown handle";
						const requested = cancelRequested.has(send.txid);
						return (
							<li
								key={send.txid}
								className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
							>
								<div className="min-w-0 flex-1">
									<div className="break-all text-sm">
										<span className="font-mono">{amountText}</span> to {to}
									</div>
									<div className="font-mono text-xs text-muted-foreground">
										{shortTxid(send.txid)}
									</div>
								</div>
								<div className="flex items-center gap-2">
									{requested ? (
										<Badge variant="secondary">Cancel requested</Badge>
									) : (
										<>
											{undelivered.has(send.txid) ? (
												<Badge variant="outline">Not delivered</Badge>
											) : null}
											<CancelSendDialog
												send={send}
												label={`${amountText} to ${to}`}
												onRequested={(message) => {
													setCancelRequested(
														(previous) => new Set([...previous, send.txid]),
													);
													setNotice(message);
												}}
												onRefused={setNotice}
											/>
										</>
									)}
								</div>
							</li>
						);
					})}
				</ul>
			) : null}
		</section>
	);
}
