"use client";

/**
 * The swap step of the trade window: once both offers are locked, each wallet
 * confirms once, the builder's wallet funds one transaction, the other wallet
 * checks and signs only its own inputs, and the builder sends it. Each wallet
 * then adds what it received.
 */
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowRightLeft, CheckCircle2, Gift, Loader2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { signP2PCommand } from "@/lib/p2p-auth";
import {
	clearPendingSwap,
	listPendingSwaps,
	savePendingSwap,
} from "@/lib/p2p-swap/pending";
import {
	abandonSwapBuild,
	buildSwapCandidate,
	clearSentSwap,
	finishSwap,
	prepareContribution,
	readSentSwap,
	readStoredBuild,
	receiveSwap,
	reconcileSwap,
	reportSwapFailure,
	SwapError,
	type SwapSession,
	type SwapSettlementView,
	signSwapCandidate,
} from "@/lib/p2p-swap/wallet";
import {
	SWAP_TERMS_MESSAGE,
	type SwapSide,
	type SwapStep,
	swapBuilder,
} from "@/lib/p2p-swap/wire";
import type { P2PTradeItem } from "@/lib/types/p2p";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import { api } from "../../convex/_generated/api";

type SessionDoc = NonNullable<FunctionReturnType<typeof api.p2p.getSession>>;

const RECONCILE_MS = 15_000;

/** "Allow giving gifts" is the giver's own choice, off by default. */
export const ALLOW_GIFTS_KEY = "1sat-p2p-allow-gifts";

export function readAllowGifts(): boolean {
	try {
		return localStorage.getItem(ALLOW_GIFTS_KEY) === "1";
	} catch (error) {
		reportSwapFailure("read-gift-setting", error);
		return false;
	}
}

export function writeAllowGifts(allow: boolean) {
	try {
		if (allow) localStorage.setItem(ALLOW_GIFTS_KEY, "1");
		else localStorage.removeItem(ALLOW_GIFTS_KEY);
	} catch (error) {
		reportSwapFailure("save-gift-setting", error);
	}
}

export function toSwapSession(doc: SessionDoc): SwapSession {
	return {
		sessionId: doc.sessionId,
		initiatorIdentity: doc.initiatorIdentity,
		participantIdentity: doc.participantIdentity,
		initiatorRevision: doc.initiatorRevision,
		participantRevision: doc.participantRevision,
		initiatorItems: doc.initiatorItems as P2PTradeItem[],
		participantItems: doc.participantItems as P2PTradeItem[],
		initiatorAllowsGift: doc.initiatorAllowsGift,
		participantAllowsGift: doc.participantAllowsGift,
	};
}

function errorMessage(error: unknown, fallback: string): string {
	if (error instanceof SwapError) return error.message;
	if (error instanceof Error && error.message.length < 160)
		return error.message;
	return fallback;
}

function shortTxid(txid: string) {
	return `${txid.slice(0, 8)}…${txid.slice(-8)}`;
}

/** The switch the giver turns on to allow a one-sided trade. */
export function AllowGiftsSwitch({
	checked,
	disabled,
	onCheckedChange,
}: {
	checked: boolean;
	disabled?: boolean;
	onCheckedChange: (checked: boolean) => void;
}) {
	return (
		<div className="flex items-center justify-between gap-3 rounded-md border p-3">
			<Label
				className="flex items-center gap-2 font-normal text-sm"
				htmlFor="p2p-allow-gifts"
			>
				<Gift className="size-4 text-primary" /> Allow giving gifts
			</Label>
			<Switch
				checked={checked}
				disabled={disabled}
				id="p2p-allow-gifts"
				onCheckedChange={onCheckedChange}
			/>
		</div>
	);
}

/**
 * Finds swaps this browser signed or built that landed after the session
 * went away, and adds their receipts to the wallet.
 */
export function useSwapRecovery(identityKey: string | null) {
	const { oneSatContext, connectionMode } = useWalletToolbox();
	const ran = useRef<string | null>(null);
	useEffect(() => {
		if (!identityKey || !oneSatContext || connectionMode !== "built-in") return;
		if (ran.current === identityKey) return;
		ran.current = identityKey;
		void (async () => {
			for (const pending of listPendingSwaps(identityKey)) {
				const candidate = pending.settlement.candidate;
				if (!candidate) continue;
				try {
					const found = await reconcileSwap(oneSatContext, candidate.txHex);
					if (!found) continue;
					if (found.kind === "txid") {
						await receiveSwap(
							oneSatContext,
							pending.session,
							pending.settlement,
							pending.me,
							found.txid,
						);
					}
					clearPendingSwap(identityKey, pending.session.sessionId);
				} catch (error) {
					reportSwapFailure("recover", error);
				}
			}
		})();
	}, [identityKey, oneSatContext, connectionMode]);
}

type Phase =
	| { kind: "idle" }
	| { kind: "working"; label: string }
	| { kind: "error"; message: string };

/**
 * The swap footer: what happens next, the one Confirm each side presses, and
 * the result. Drives the automatic steps (contribute, finish, receive).
 */
export function SwapPanel({
	session,
	me,
	myIdentity,
}: {
	session: SessionDoc;
	me: SwapSide;
	myIdentity: string;
}) {
	const { wallet, oneSatContext, connectionMode, refreshBalance } =
		useWalletToolbox();
	const settle = useMutation(api.p2p.settle);
	const [phase, setPhase] = useState<Phase>({ kind: "idle" });
	const attempted = useRef(new Set<string>());
	const [retry, setRetry] = useState(0);

	const swap = useMemo(() => toSwapSession(session), [session]);
	const terms = swapBuilder(swap);
	const settlement = session.settlement as SwapSettlementView | undefined;
	const builder = settlement?.builder ?? (terms.ok ? terms.builder : null);
	const iBuild = builder === me;
	const supported = connectionMode === "built-in";
	const sessionId = session.sessionId;
	const status = session.status;

	const post = useCallback(
		async (step: SwapStep) => {
			if (!wallet)
				throw new SwapError("no-wallet", "Unlock your wallet first.");
			const signed = await signP2PCommand(wallet, "session.settle", {
				sessionId,
				...step,
			});
			await settle(signed);
		},
		[wallet, settle, sessionId],
	);

	// Without this record a swap that lands later can't be found, so a
	// failure here stops the step before anything is signed.
	const remember = useCallback(
		(view: SwapSettlementView) => {
			try {
				savePendingSwap({
					identityKey: myIdentity,
					me,
					session: swap,
					settlement: view,
					savedAt: Date.now(),
				});
			} catch (error) {
				reportSwapFailure("save-pending", error);
				throw new SwapError(
					"save-pending",
					"This browser couldn't save the swap record, so nothing was signed. Free some storage and try again.",
				);
			}
		},
		[myIdentity, me, swap],
	);

	const run = useCallback(
		async (key: string, label: string, task: () => Promise<void>) => {
			if (attempted.current.has(key)) return;
			attempted.current.add(key);
			setPhase({ kind: "working", label });
			try {
				await task();
				setPhase({ kind: "idle" });
			} catch (error) {
				reportSwapFailure(key.split(":")[0], error);
				setPhase({
					kind: "error",
					message: errorMessage(error, "The swap step failed. Try again."),
				});
			}
		},
		[],
	);

	const revisionKey = `${swap.initiatorRevision}-${swap.participantRevision}`;
	const ctx = supported ? oneSatContext : null;
	const termsOk = terms.ok;

	// The non-builder sends its half as soon as both offers are locked.
	useEffect(() => {
		if (!ctx || !termsOk || iBuild || status !== "ready") return;
		void run(
			`contribute:${revisionKey}:${retry}`,
			"Preparing your side…",
			async () => {
				const contribution = await prepareContribution(ctx, swap, me);
				await post({ step: "contribute", contribution });
			},
		);
	}, [ctx, termsOk, iBuild, status, revisionKey, retry, run, post, swap, me]);

	const candidateHash = settlement?.candidate?.hash;
	const contributorSigns = (settlement?.contribution.inputs.length ?? 0) > 0;
	const signed = Boolean(settlement?.signatures) || !contributorSigns;
	const hasOutcome = Boolean(settlement?.outcome);

	// The builder sends the swap once the other side has signed.
	useEffect(() => {
		if (!ctx || !settlement || !iBuild || !candidateHash || !signed) return;
		if (hasOutcome || status !== "settling") return;
		if (!readStoredBuild(sessionId)) return;
		void run(
			`finish:${candidateHash}:${retry}`,
			"Sending the swap…",
			async () => {
				remember(settlement);
				const result = await finishSwap(ctx, swap, settlement);
				if (result.kind === "txid") {
					await post({
						step: "outcome",
						outcome: { kind: "txid", txid: result.txid },
					});
					return;
				}
				if (result.kind === "failed") {
					clearPendingSwap(myIdentity, sessionId);
					await post({
						step: "outcome",
						outcome: { kind: "failed", reason: result.message },
					});
					return;
				}
				reportSwapFailure(
					"finish",
					new SwapError(result.code, "The swap outcome is unknown"),
				);
				await post({ step: "outcome", outcome: { kind: "unknown" } });
			},
		);
	}, [
		ctx,
		settlement,
		iBuild,
		candidateHash,
		signed,
		hasOutcome,
		status,
		sessionId,
		retry,
		run,
		remember,
		swap,
		post,
		myIdentity,
	]);

	// When the outcome is unknown, both sides look for the swap on chain. Once
	// this side has signed, it looks too, in case the builder sent it and
	// couldn't report it.
	const unknown = settlement?.outcome?.kind === "unknown";
	const candidateHex = settlement?.candidate?.txHex;
	const watchChain =
		unknown || (!iBuild && Boolean(settlement?.signatures) && !hasOutcome);
	useEffect(() => {
		if (!ctx || !watchChain || !candidateHex) return;
		let stopped = false;
		const check = async () => {
			try {
				const found = await reconcileSwap(ctx, candidateHex);
				if (stopped || !found) return;
				if (found.kind === "txid") {
					await post({
						step: "outcome",
						outcome: { kind: "txid", txid: found.txid },
					});
				} else if (iBuild && unknown) {
					await post({
						step: "outcome",
						outcome: {
							kind: "failed",
							reason:
								"An asset in the swap moved elsewhere, so the swap didn't happen.",
						},
					});
				}
			} catch (error) {
				reportSwapFailure("reconcile", error);
			}
		};
		void check();
		const timer = setInterval(() => void check(), RECONCILE_MS);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [ctx, watchChain, unknown, candidateHex, iBuild, post]);

	// A swap this tab sent whose outcome didn't reach the relay is reported
	// again, never stopped.
	useEffect(() => {
		if (!ctx || !iBuild || hasOutcome || status !== "settling") return;
		const sent = readSentSwap(sessionId);
		if (!sent) return;
		void run(`sent:${sent}:${retry}`, "Recording the swap…", () =>
			post({ step: "outcome", outcome: { kind: "txid", txid: sent } }),
		);
	}, [ctx, iBuild, hasOutcome, status, sessionId, retry, run, post]);

	// After the swap is broadcast, each side adds what it received.
	const txid =
		settlement?.outcome?.kind === "txid" ? settlement.outcome.txid : null;
	const [received, setReceived] = useState(false);
	useEffect(() => {
		if (!ctx || !txid || !settlement) return;
		void run(
			`receive:${txid}:${retry}`,
			"Adding what you received…",
			async () => {
				try {
					await receiveSwap(ctx, swap, settlement, me, txid);
				} catch (error) {
					// A reported txid that isn't this swap: release any funding
					// this side still holds for it.
					if (
						iBuild &&
						error instanceof SwapError &&
						error.code === "final-mismatch"
					) {
						await abandonSwapBuild(ctx, sessionId).catch((abandonError) =>
							reportSwapFailure("abandon", abandonError),
						);
					}
					throw error;
				}
				clearPendingSwap(myIdentity, sessionId);
				clearSentSwap(sessionId);
				// Both sides' balances and ordinals change with the swap.
				refreshBalance();
				setReceived(true);
			},
		);
	}, [
		ctx,
		txid,
		settlement,
		retry,
		run,
		swap,
		me,
		myIdentity,
		sessionId,
		iBuild,
		refreshBalance,
	]);

	// A build left over from a swap that was cancelled or reset is released.
	useEffect(() => {
		if (!ctx || !iBuild) return;
		if (status === "settling" || status === "settled") return;
		if (!readStoredBuild(sessionId)) return;
		abandonSwapBuild(ctx, sessionId).catch((error) =>
			reportSwapFailure("abandon", error),
		);
	}, [ctx, iBuild, status, sessionId]);

	const confirmBuild = () =>
		void run(
			`build:${revisionKey}:${Date.now()}`,
			"Preparing the swap…",
			async () => {
				if (!ctx || !settlement) return;
				// Only one build is ever held, so an earlier one is released first.
				await abandonSwapBuild(ctx, sessionId);
				const built = await buildSwapCandidate(ctx, swap, settlement);
				try {
					await post({ step: "candidate", txHex: built.txHex });
				} catch (error) {
					await abandonSwapBuild(ctx, sessionId).catch((abandonError) =>
						reportSwapFailure("abandon", abandonError),
					);
					throw error;
				}
			},
		);

	const confirmSign = () =>
		void run(
			`sign:${candidateHash}:${Date.now()}`,
			"Checking and signing…",
			async () => {
				if (!ctx || !settlement?.candidate) return;
				const result = await signSwapCandidate(ctx, swap, settlement, me);
				remember(settlement);
				await post({
					step: "signatures",
					candidateHash: result.hash,
					signatures: result.signatures,
				});
			},
		);

	const cancelBuild = () =>
		void run(`reset:${Date.now()}`, "Stopping the swap…", async () => {
			const held = Boolean(readStoredBuild(sessionId));
			if (ctx && held) await abandonSwapBuild(ctx, sessionId);
			// Signed but not held here: it may have been sent from another tab
			// or before a reload, so the chain decides.
			if (ctx && !held && settlement?.signatures && candidateHex) {
				const found = await reconcileSwap(ctx, candidateHex);
				if (found?.kind === "txid") {
					await post({
						step: "outcome",
						outcome: { kind: "txid", txid: found.txid },
					});
					return;
				}
				if (!found) {
					await post({ step: "outcome", outcome: { kind: "unknown" } });
					return;
				}
			}
			await post({
				step: "outcome",
				outcome: {
					kind: "failed",
					reason:
						"The swap was stopped before it was sent. Lock both offers to try again.",
				},
			});
		});

	const working = phase.kind === "working";
	let note: string;
	let action: {
		label: string;
		onClick: () => void;
		variant?: "secondary";
	} | null = null;

	if (session.status === "settled" && txid) {
		note = received
			? "Swap complete. What you received is in your wallet."
			: "Swap sent. Adding what you received to your wallet.";
	} else if (!supported) {
		note =
			"Swap isn't supported in this wallet yet. Use the 1Sat web wallet to swap.";
	} else if (session.status === "negotiating") {
		note = session.lastSettlementError
			? `${session.lastSettlementError}`
			: "Lock both offers to swap. Closing cancels the session for both of you.";
	} else if (!terms.ok) {
		note = SWAP_TERMS_MESSAGE[terms.error];
	} else if (session.status === "ready") {
		note = iBuild
			? "Waiting for their wallet to prepare its side."
			: "Preparing your side of the swap.";
	} else if (unknown) {
		note =
			"The swap was sent, and the network hasn't confirmed it yet. Checking.";
	} else if (!settlement?.candidate) {
		if (iBuild) {
			note =
				"Both offers are locked. Confirm to swap. You pay the network fee and any token fee.";
			action = { label: "Confirm swap", onClick: confirmBuild };
		} else {
			note = "Waiting for them to confirm the swap.";
		}
	} else if (!signed) {
		if (iBuild) {
			note = "Waiting for them to check and sign the swap.";
			action = {
				label: "Stop swap",
				onClick: cancelBuild,
				variant: "secondary",
			};
		} else {
			note =
				"They confirmed. Your wallet checks the swap matches both offers before it signs.";
			action = { label: "Confirm swap", onClick: confirmSign };
		}
	} else if (iBuild && readSentSwap(sessionId)) {
		note = "Swap sent. Recording it.";
	} else if (iBuild && !readStoredBuild(sessionId)) {
		note =
			"This swap was prepared in another tab or before a reload, so it can't be sent from here.";
		action = { label: "Stop swap", onClick: cancelBuild, variant: "secondary" };
	} else {
		note = iBuild
			? "Sending the swap."
			: "Signed. Waiting for them to send the swap.";
	}

	if (phase.kind === "error" && !action) {
		action = {
			label: "Try again",
			onClick: () => {
				setPhase({ kind: "idle" });
				setRetry((count) => count + 1);
			},
			variant: "secondary",
		};
	}

	return (
		<div className="flex flex-col gap-3 border-t bg-muted/30 px-4 pt-4 pb-[max(--spacing(4),env(safe-area-inset-bottom))] sm:flex-row sm:items-center sm:justify-between sm:px-6">
			<div className="min-w-0 space-y-1">
				<p
					className="text-muted-foreground text-xs"
					data-testid="trade-settlement-note"
				>
					{working ? phase.label : note}
				</p>
				{phase.kind === "error" && (
					<p className="text-destructive text-xs" role="alert">
						{phase.message}
					</p>
				)}
				{txid && (
					<Link
						className="font-mono text-primary text-xs underline-offset-2 hover:underline"
						href={`/tx/${txid}`}
					>
						{shortTxid(txid)}
					</Link>
				)}
			</div>
			{session.status === "settled" ? (
				<span className="flex items-center gap-2 font-medium text-sm">
					<CheckCircle2 className="size-4 text-chart-4" /> Swapped
				</span>
			) : action ? (
				<Button
					className="w-full sm:w-auto"
					disabled={working}
					onClick={action.onClick}
					variant={action.variant}
				>
					{working ? (
						<Loader2 className="size-4 animate-spin" data-icon="inline-start" />
					) : (
						<ArrowRightLeft className="size-4" data-icon="inline-start" />
					)}
					{action.label}
				</Button>
			) : (
				<Button className="w-full sm:w-auto" disabled variant="secondary">
					{working ? (
						<Loader2 className="size-4 animate-spin" data-icon="inline-start" />
					) : null}
					{session.status === "negotiating"
						? "Lock both offers to continue"
						: "Swap in progress"}
				</Button>
			)}
		</div>
	);
}
