"use client";

import type { WalletInterface } from "@bsv/sdk";
import { useMutation, useQuery } from "convex/react";
import { Bell, Clock, Fingerprint } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	SoundAlertDialog,
	SoundAlertDialogAction,
	SoundAlertDialogCancel,
} from "@/components/ui/sound-alert-dialog";
import { useSound } from "@/hooks/use-sound";
import { signP2PCommand } from "@/lib/p2p-auth";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import { api } from "../../convex/_generated/api";
import { TradeDialog } from "./trade-dialog";
import {
	inboxRenewalDelay,
	recoverActiveSession,
} from "./trade-request-lifecycle";

function shortIdentity(value: string): string {
	return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

const INBOX_RETRY_MS = 60 * 1000;

function ConnectedTradeRequestListener({
	identityKey,
	wallet,
}: {
	identityKey: string;
	wallet: WalletInterface;
}) {
	const { play } = useSound();
	const openInbox = useMutation(api.p2p.openInbox);
	const acceptRequest = useMutation(api.p2p.acceptRequest);
	const declineRequest = useMutation(api.p2p.declineRequest);
	const cancelRequest = useMutation(api.p2p.cancelRequest);
	const cancelSession = useMutation(api.p2p.cancelSession);
	const [inboxToken] = useState(() => crypto.randomUUID());
	const [inboxReady, setInboxReady] = useState(false);
	const [activeSession, setActiveSession] = useState<{
		sessionId: string;
		peerIdentity: string;
	} | null>(null);
	const seenIncoming = useRef<string | null>(null);
	const terminalSession = useRef<string | null>(null);
	const resolvingIncoming = useRef(false);

	// react-doctor-disable-next-line react-doctor/effect-needs-cleanup -- the returned cleanup clears timer and cancelled blocks late async rescheduling.
	useEffect(() => {
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let capabilityExpiresAt = 0;
		let reportedUnavailable = false;

		const schedule = (delay: number) => {
			if (cancelled) return;
			timer = setTimeout(() => void renew(), delay);
		};
		const renew = async () => {
			try {
				const signed = await signP2PCommand(wallet, "inbox.open", {
					token: inboxToken,
				});
				const result = await openInbox(signed);
				if (cancelled) return;
				capabilityExpiresAt = result.expiresAt;
				reportedUnavailable = false;
				setInboxReady(true);
				schedule(inboxRenewalDelay(result.expiresAt));
			} catch (error) {
				if (cancelled) return;
				if (capabilityExpiresAt <= Date.now()) setInboxReady(false);
				if (!reportedUnavailable) {
					reportedUnavailable = true;
					toast.error(
						error instanceof Error
							? `P2P inbox unavailable: ${error.message}`
							: "P2P inbox unavailable.",
					);
				}
				schedule(
					capabilityExpiresAt > Date.now()
						? Math.min(
								INBOX_RETRY_MS,
								Math.max(1_000, capabilityExpiresAt - Date.now() - 1_000),
							)
						: INBOX_RETRY_MS,
				);
			}
		};

		void renew();
		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
		};
	}, [inboxToken, openInbox, wallet]);

	const inbox = useQuery(
		api.p2p.inbox,
		inboxReady && inboxToken ? { token: inboxToken } : "skip",
	);
	const activeTrade = useQuery(
		api.p2p.getSession,
		activeSession ? { sessionId: activeSession.sessionId } : "skip",
	);

	const incoming = activeSession ? null : (inbox?.incoming[0] ?? null);
	useEffect(() => {
		if (!incoming) {
			seenIncoming.current = null;
			resolvingIncoming.current = false;
			return;
		}
		if (seenIncoming.current === incoming.requestId) return;
		seenIncoming.current = incoming.requestId;
		play("alert");
	}, [incoming, play]);

	const recoverableSession = recoverActiveSession(
		inbox?.activeSessions[0],
		identityKey,
	);
	useEffect(() => {
		if (
			!recoverableSession ||
			activeSession ||
			terminalSession.current === recoverableSession.sessionId
		) {
			return;
		}
		play("dialog");
		queueMicrotask(() => setActiveSession(recoverableSession));
	}, [activeSession, play, recoverableSession]);

	useEffect(() => {
		if (
			activeTrade &&
			(activeTrade.status === "cancelled" || activeTrade.status === "expired")
		) {
			terminalSession.current = activeTrade.sessionId;
			play("dialog", 0.2);
			queueMicrotask(() => setActiveSession(null));
		}
	}, [activeTrade, play]);

	const signAndRun = async (
		action:
			| "request.accept"
			| "request.decline"
			| "request.cancel"
			| "session.cancel",
		payload: Record<string, string>,
		run: (signed: { body: string; signature: string }) => Promise<unknown>,
	) => {
		const signed = await signP2PCommand(wallet, action, payload);
		return run(signed);
	};

	const handleAccept = async () => {
		if (!incoming || resolvingIncoming.current) return;
		resolvingIncoming.current = true;
		try {
			const result = (await signAndRun(
				"request.accept",
				{
					requestId: incoming.requestId,
					sessionId: crypto.randomUUID(),
				},
				acceptRequest,
			)) as { sessionId: string };
			play("dialog");
			setActiveSession({
				sessionId: result.sessionId,
				peerIdentity: incoming.fromIdentity,
			});
		} catch (error) {
			resolvingIncoming.current = false;
			toast.error(
				error instanceof Error
					? error.message
					: "The request could not be accepted.",
			);
		}
	};

	const handleDecline = async () => {
		if (!incoming || resolvingIncoming.current) return;
		resolvingIncoming.current = true;
		try {
			await signAndRun(
				"request.decline",
				{ requestId: incoming.requestId },
				declineRequest,
			);
			play("decline");
		} catch (error) {
			resolvingIncoming.current = false;
			toast.error(
				error instanceof Error
					? error.message
					: "The request could not be declined.",
			);
		}
	};

	const pending = inbox?.outgoingPending[0] ?? null;
	const handleCancelPending = async () => {
		if (!pending) return;
		try {
			await signAndRun(
				"request.cancel",
				{ requestId: pending.requestId },
				cancelRequest,
			);
			play("decline");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "The request could not be cancelled.",
			);
		}
	};

	const handleCloseTrade = async (open: boolean) => {
		if (open || !activeSession) return;
		try {
			await signAndRun(
				"session.cancel",
				{ sessionId: activeSession.sessionId },
				cancelSession,
			);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "The session could not be cancelled.",
			);
			return;
		}
		// Keep rendering the authoritative session until the reactive query observes
		// its terminal state. Clearing early can recover the same stale active row.
	};

	return (
		<>
			<SoundAlertDialog
				onOpenChange={(open) => !open && void handleCancelPending()}
				open={Boolean(pending && !activeSession)}
			>
				<AlertDialogContent className="sm:max-w-md">
					<AlertDialogHeader>
						<AlertDialogTitle className="flex items-center gap-2 text-xl">
							<Clock className="size-5 text-muted-foreground" /> Waiting for
							response
						</AlertDialogTitle>
						<AlertDialogDescription asChild>
							<div className="flex items-center gap-3 pt-2">
								<Fingerprint className="size-10 rounded-full border border-primary/20 p-2 text-primary" />
								<span>
									<span className="block font-mono font-medium text-foreground">
										{pending ? shortIdentity(pending.toIdentity) : ""}
									</span>
									<span className="text-muted-foreground text-sm">
										is deciding whether to accept your request…
									</span>
								</span>
							</div>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<SoundAlertDialogCancel>Cancel request</SoundAlertDialogCancel>
					</AlertDialogFooter>
				</AlertDialogContent>
			</SoundAlertDialog>

			<SoundAlertDialog
				onOpenChange={(open) => {
					if (!open && !resolvingIncoming.current) void handleDecline();
				}}
				open={Boolean(incoming)}
				openSound={false}
			>
				<AlertDialogContent className="sm:max-w-md">
					<AlertDialogHeader>
						<AlertDialogTitle className="flex items-center gap-2 text-xl">
							<Bell className="size-5 text-primary" /> Trade request
						</AlertDialogTitle>
						<AlertDialogDescription asChild>
							<div className="flex items-center gap-3 pt-2">
								<Fingerprint className="size-10 rounded-full border border-primary/20 p-2 text-primary" />
								<span>
									<span className="block font-mono font-medium text-foreground">
										{incoming ? shortIdentity(incoming.fromIdentity) : ""}
									</span>
									<span className="text-muted-foreground text-sm">
										wants to trade with you
									</span>
								</span>
							</div>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<SoundAlertDialogCancel onClick={() => void handleDecline()}>
							Decline
						</SoundAlertDialogCancel>
						<SoundAlertDialogAction onClick={() => void handleAccept()}>
							Accept trade
						</SoundAlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</SoundAlertDialog>

			{activeSession && identityKey && (
				<TradeDialog
					myIdentity={identityKey}
					onOpenChange={(open) => void handleCloseTrade(open)}
					open
					peerIdentity={activeSession.peerIdentity}
					sessionId={activeSession.sessionId}
				/>
			)}
		</>
	);
}

export function TradeRequestListener() {
	const { connectionStatus, identityKey, wallet } = useWalletToolbox();
	return process.env.NEXT_PUBLIC_CONVEX_URL &&
		connectionStatus === "ready" &&
		identityKey &&
		wallet ? (
		<ConnectedTradeRequestListener
			identityKey={identityKey}
			key={identityKey}
			wallet={wallet}
		/>
	) : null;
}
