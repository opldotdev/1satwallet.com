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

function shortIdentity(value: string): string {
	return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

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
	const openingInbox = useRef(false);
	const seenIncoming = useRef<string | null>(null);
	const seenAccepted = useRef<string | null>(null);
	const resolvingIncoming = useRef(false);

	useEffect(() => {
		if (openingInbox.current) return;
		openingInbox.current = true;
		void signP2PCommand(wallet, "inbox.open", { token: inboxToken })
			.then((signed) => openInbox(signed))
			.then(() => setInboxReady(true))
			.catch((error) => {
				openingInbox.current = false;
				toast.error(
					error instanceof Error
						? `P2P inbox unavailable: ${error.message}`
						: "P2P inbox unavailable.",
				);
			});
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

	const acceptedRequest = inbox?.outgoingAccepted[0];
	useEffect(() => {
		if (
			!acceptedRequest?.sessionId ||
			seenAccepted.current === acceptedRequest.requestId
		) {
			return;
		}
		seenAccepted.current = acceptedRequest.requestId;
		play("dialog");
		queueMicrotask(() =>
			setActiveSession({
				sessionId: acceptedRequest.sessionId as string,
				peerIdentity: acceptedRequest.toIdentity,
			}),
		);
	}, [acceptedRequest, play]);

	useEffect(() => {
		if (
			activeTrade &&
			(activeTrade.status === "cancelled" || activeTrade.status === "expired")
		) {
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
		if (!incoming) return;
		resolvingIncoming.current = true;
		try {
			const sessionId = crypto.randomUUID();
			await signAndRun(
				"request.accept",
				{ requestId: incoming.requestId, sessionId },
				acceptRequest,
			);
			play("dialog");
			setActiveSession({ sessionId, peerIdentity: incoming.fromIdentity });
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
		if (!incoming) return;
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
		}
		setActiveSession(null);
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
	const { identityKey, wallet } = useWalletToolbox();
	return process.env.NEXT_PUBLIC_CONVEX_URL && identityKey && wallet ? (
		<ConnectedTradeRequestListener
			identityKey={identityKey}
			key={identityKey}
			wallet={wallet}
		/>
	) : null;
}
