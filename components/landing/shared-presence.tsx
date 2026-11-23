"use client";

import usePresence from "@convex-dev/presence/react";
import { useMutation, useQuery } from "convex/react";
import {
	ArrowRightLeft,
	Copy,
	LogOut,
	MousePointer2,
	RefreshCw,
	Users,
} from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
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
import {
	type FloorState,
	floorCountLabel,
	floorPeers,
	landingFloorState,
	readFloorLeft,
	readSavedExternalWallet,
	writeFloorLeft,
} from "@/lib/p2p-floor";
import {
	getWalletPresenceUserId,
	PRESENCE_ANNOUNCEMENT_REFRESH_MS,
	PRESENCE_ROOM_ID,
} from "@/lib/p2p-presence";
import { publicProfileClaimFromWallet } from "@/lib/p2p-public-profile";
import { reportFailure } from "@/lib/runtime-diagnostics";
import { useWallet } from "@/providers/wallet-provider";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import { api } from "../../convex/_generated/api";

interface CursorData {
	x: number;
	y: number;
}

/** A peer's signed identity, as the floor list returns it. */
interface PeerIdentity {
	userId: string;
	identityKey: string;
	label: string;
	expiresAt: number;
	profile?: { displayName?: string; avatarUrl?: string };
}

const ROOM_ID = PRESENCE_ROOM_ID;
const HEARTBEAT_INTERVAL = 10_000;
/** How long the relay may take to record a signed announcement. */
const ANNOUNCE_TIMEOUT_MS = 15_000;
/** How long a saved external wallet gets to start reconnecting on load. */
const RESUME_GRACE_MS = 3_000;
const CURSOR_COLORS = [
	"var(--chart-1)",
	"var(--chart-2)",
	"var(--chart-3)",
	"var(--chart-4)",
	"var(--chart-5)",
];

function truncateIdentifier(identifier: string): string {
	return identifier.length <= 12
		? identifier
		: `${identifier.slice(0, 6)}…${identifier.slice(-4)}`;
}

/** The floor id of one tab's wallet, or null without a valid identity key. */
export function getPresenceUserId(
	identityKey: string | null,
	sessionId: string,
	chain: "main" | "test" = "main",
): string | null {
	const normalizedIdentityKey = identityKey?.toLowerCase();
	return normalizedIdentityKey &&
		/^(02|03)[0-9a-f]{64}$/.test(normalizedIdentityKey)
		? getWalletPresenceUserId(normalizedIdentityKey, chain, sessionId)
		: null;
}

function peerName(identity: PeerIdentity): string {
	return identity.profile?.displayName ?? identity.label;
}

function isCursorData(value: unknown): value is CursorData {
	if (!value || typeof value !== "object") return false;
	const data = value as Partial<CursorData>;
	return Number.isFinite(data.x) && Number.isFinite(data.y);
}

function copyIdentityKey(identityKey: string) {
	void navigator.clipboard.writeText(identityKey).then(
		() => toast.success("Identity key copied."),
		(error) => {
			console.warn("[p2p-floor] clipboard write failed", error);
			toast.error("Could not copy the identity key.");
		},
	);
}

class FloorUnreachableError extends Error {
	constructor() {
		super(
			"The trading floor isn't responding. Check your connection and try again.",
		);
		this.name = "FloorUnreachableError";
	}
}

/** Convex queues a mutation while offline and never rejects it; this does. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new FloorUnreachableError()), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

function shortReason(error: unknown, fallback: string): string {
	const message = error instanceof Error ? error.message.trim() : "";
	return message ? message.slice(0, 160) : fallback;
}

export interface LandingFloor {
	state: FloorState;
	userId: string | null;
	selfName: string | null;
	chain: "main" | "test";
	leave: () => void;
	rejoin: () => void;
	retry: () => void;
}

/**
 * Who this tab is on the floor. The wallet signs a presence announcement
 * (refreshed every minute) before the tab joins; without a connected,
 * unlocked wallet nothing is announced, joined or read.
 */
export function useLandingFloor(): LandingFloor {
	const {
		chain,
		connectionStatus,
		identityKey,
		isInitialized,
		isInitializing,
		oneSatContext,
		wallet,
	} = useWalletToolbox();
	const { hasWallet, isWalletInitialized, isWalletLocked } = useWallet();
	const announce = useMutation(api.presence.announce);
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [left, setLeft] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const [announced, setAnnounced] = useState<{
		userId: string;
		wallet: unknown;
		displayName: string | null;
	} | null>(null);
	const [announceError, setAnnounceError] = useState<{
		userId: string;
		wallet: unknown;
		message: string;
	} | null>(null);
	const [savedExternal, setSavedExternal] = useState(false);
	const [resumeGrace, setResumeGrace] = useState(true);

	// react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- the session id, the Leave flag and the saved wallet mode are read after hydration so server and client markup match.
	useEffect(() => {
		setSessionId(crypto.randomUUID());
		setLeft(readFloorLeft());
		setSavedExternal(readSavedExternalWallet());
		const timer = setTimeout(() => setResumeGrace(false), RESUME_GRACE_MS);
		return () => clearTimeout(timer);
	}, []);

	const convexConfigured = Boolean(process.env.NEXT_PUBLIC_CONVEX_URL);
	const userId = sessionId
		? getPresenceUserId(identityKey, sessionId, chain)
		: null;
	const canJoin =
		convexConfigured &&
		connectionStatus === "ready" &&
		Boolean(userId && wallet && oneSatContext) &&
		!left;

	// react-doctor-disable-next-line react-doctor/effect-needs-cleanup -- the returned cleanup clears refreshTimer and cancelled blocks late async rescheduling.
	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt re-runs the announcement after Try again.
	useEffect(() => {
		if (!canJoin || !userId || !wallet || !oneSatContext || !sessionId) {
			return;
		}
		let cancelled = false;
		let refreshTimer: ReturnType<typeof setTimeout> | undefined;
		let publicProfile: Awaited<ReturnType<typeof publicProfileClaimFromWallet>>;
		let profileLoaded = false;
		const publish = async () => {
			try {
				if (!profileLoaded) {
					publicProfile = await publicProfileClaimFromWallet(
						oneSatContext,
					).catch((error) => {
						// The floor works without a profile; the key's short form is shown.
						console.warn("[p2p-floor] public profile unavailable", error);
						return undefined;
					});
					profileLoaded = true;
				}
				const signed = await signP2PCommand(wallet, "presence.announce", {
					chain,
					sessionId,
					userId,
					...(publicProfile ? { publicProfile } : {}),
				});
				await withTimeout(announce(signed), ANNOUNCE_TIMEOUT_MS);
				if (!cancelled) {
					setAnnounceError(null);
					setAnnounced({
						userId,
						wallet,
						displayName: publicProfile?.displayName ?? null,
					});
				}
			} catch (error) {
				reportFailure(
					{
						category: "action",
						code: "action.failed",
						operation: "p2p-floor.announce",
						recoverable: true,
					},
					error,
				);
				if (!cancelled) {
					setAnnounced(null);
					setAnnounceError({
						userId,
						wallet,
						message: shortReason(
							error,
							"Your wallet did not sign your presence.",
						),
					});
				}
				// A failed signature is not retried on its own: the user may have
				// declined it. Try again asks again.
				return;
			}
			if (!cancelled) {
				refreshTimer = setTimeout(publish, PRESENCE_ANNOUNCEMENT_REFRESH_MS);
			}
		};
		void publish();
		return () => {
			cancelled = true;
			if (refreshTimer) clearTimeout(refreshTimer);
		};
	}, [
		announce,
		attempt,
		canJoin,
		chain,
		oneSatContext,
		sessionId,
		userId,
		wallet,
	]);

	const isAnnounced =
		announced?.wallet === wallet && announced.userId === userId;
	// An error belongs to the wallet and session that hit it; a new wallet or
	// an unlock starts over at joining.
	const currentError =
		announceError?.wallet === wallet && announceError.userId === userId
			? announceError.message
			: null;
	const state = landingFloorState({
		convexConfigured,
		// Until the built-in wallet has loaded, or a saved external wallet has
		// had its moment to reconnect, it is too early to say "connect".
		resolving:
			!sessionId ||
			!isWalletInitialized ||
			(savedExternal && !isInitialized && (isInitializing || resumeGrace)),
		connectionStatus,
		// Before hydration there is no session id yet; a ready wallet is joining.
		hasIdentity: Boolean(userId && wallet && oneSatContext) || !sessionId,
		hasBuiltInWallet: hasWallet,
		isBuiltInWalletLocked: isWalletLocked,
		left,
		announce: isAnnounced
			? "ok"
			: currentError
				? { error: currentError }
				: "pending",
	});

	return {
		state,
		userId: isAnnounced ? userId : null,
		selfName:
			isAnnounced && identityKey
				? (announced?.displayName ?? truncateIdentifier(identityKey))
				: null,
		chain,
		leave: () => {
			writeFloorLeft(true);
			setLeft(true);
			setAnnounced(null);
		},
		rejoin: () => {
			writeFloorLeft(false);
			setAnnounceError(null);
			setLeft(false);
		},
		retry: () => {
			setAnnounceError(null);
			setAttempt((value) => value + 1);
		},
	};
}

function PeerContextMenu({
	displayName,
	identityKey,
	onTrade,
	children,
}: {
	displayName: string;
	identityKey: string;
	onTrade: () => void;
	children: ReactNode;
}) {
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
			<ContextMenuContent className="z-[80] w-52">
				<ContextMenuLabel className="truncate">{displayName}</ContextMenuLabel>
				<ContextMenuSeparator />
				<ContextMenuItem onSelect={onTrade}>
					<ArrowRightLeft />
					Request trade
				</ContextMenuItem>
				<ContextMenuItem onSelect={() => copyIdentityKey(identityKey)}>
					<Copy />
					Copy identity key
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

function FloorBar({ children }: { children: ReactNode }) {
	return (
		<div
			className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-[max(--spacing(3),env(safe-area-inset-bottom))] pointer-events-none"
			data-testid="floor-bar"
		>
			<div
				className="flex w-full max-w-xl items-center gap-2 rounded-2xl border border-primary/20 bg-background/90 p-2 pl-4 shadow-lg backdrop-blur-md pointer-events-auto"
				role="status"
			>
				{children}
			</div>
		</div>
	);
}

type FloorEntry = {
	userId: string;
	online: boolean;
	data?: unknown;
	identity?: PeerIdentity | null;
};

function LiveFloor({
	userId,
	selfName,
	chain,
	onLeave,
}: {
	userId: string;
	selfName: string;
	chain: "main" | "test";
	onLeave: () => void;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const lastUpdateRef = useRef(0);
	const updateInFlightRef = useRef(false);
	// The hook keeps this tab on the floor (heartbeats); the floor query reads
	// who else is on it, for this wallet only.
	usePresence(api.presence, ROOM_ID, userId, HEARTBEAT_INTERVAL);
	const floorEntries = useQuery(api.presence.floor, { userId }) as
		| FloorEntry[]
		| undefined;
	const updateCursor = useMutation(api.presence.updateCursor);
	const sendRequest = useMutation(api.p2p.sendRequest);
	const { play } = useSound();
	const { wallet, identityKey } = useWalletToolbox();
	const [peersOpen, setPeersOpen] = useState(false);
	const [confirming, setConfirming] = useState<PeerIdentity | null>(null);
	const [requesting, setRequesting] = useState(false);

	const handlePointerMove = useCallback(
		(event: PointerEvent) => {
			const now = Date.now();
			if (now - lastUpdateRef.current < 66 || updateInFlightRef.current) return;
			lastUpdateRef.current = now;

			const rect = containerRef.current?.getBoundingClientRect();
			if (!rect?.width || !rect.height) return;

			const x = Math.max(
				0,
				Math.min(100, ((event.clientX - rect.left) / rect.width) * 100),
			);
			const y = Math.max(
				0,
				Math.min(100, ((event.clientY - rect.top) / rect.height) * 100),
			);

			updateInFlightRef.current = true;
			void updateCursor({ roomId: ROOM_ID, userId, data: { x, y } })
				.catch((error) => {
					// Cursors are decoration; a dropped move is logged, not shown.
					console.warn("[p2p-floor] cursor update failed", error);
				})
				.finally(() => {
					updateInFlightRef.current = false;
				});
		},
		[updateCursor, userId],
	);

	useEffect(() => {
		if (
			!window.matchMedia("(pointer: fine) and (min-width: 768px)").matches ||
			window.matchMedia("(prefers-reduced-motion: reduce)").matches
		) {
			return;
		}
		window.addEventListener("pointermove", handlePointerMove);
		return () => window.removeEventListener("pointermove", handlePointerMove);
	}, [handlePointerMove]);

	const peers = identityKey
		? floorPeers(floorEntries, { userId, identityKey, chain })
		: [];

	const sendTradeRequest = async (peer: PeerIdentity) => {
		if (!wallet || requesting) return;
		setRequesting(true);
		play("click");
		try {
			const signed = await signP2PCommand(wallet, "request.create", {
				requestId: crypto.randomUUID(),
				toIdentity: peer.identityKey,
			});
			await sendRequest(signed);
			setConfirming(null);
			setPeersOpen(false);
		} catch (error) {
			reportFailure(
				{
					category: "action",
					code: "action.failed",
					operation: "p2p-floor.request",
					recoverable: true,
				},
				error,
			);
			toast.error(
				`The trade request was not sent. ${shortReason(error, "Try again.")}`,
			);
		} finally {
			setRequesting(false);
		}
	};

	const askToTrade = (peer: PeerIdentity) => {
		play("click");
		setConfirming(peer);
	};

	return (
		<>
			<div
				ref={containerRef}
				className="absolute inset-0 z-10 overflow-hidden pointer-events-none"
			>
				{peers.map((peer, index) => {
					const data = isCursorData(peer.data) ? peer.data : { x: 50, y: 50 };
					const color = CURSOR_COLORS[index % CURSOR_COLORS.length];
					const name = peerName(peer.identity);
					const avatarUrl = peer.identity.profile?.avatarUrl;
					return (
						<PeerContextMenu
							displayName={name}
							identityKey={peer.identity.identityKey}
							key={peer.userId}
							onTrade={() => askToTrade(peer.identity)}
						>
							<button
								aria-label={`Request a trade with ${name}`}
								className="group absolute z-30 hidden border-none bg-transparent p-0 pointer-events-auto md:block motion-safe:transition-[left,top,transform] motion-safe:duration-100 motion-safe:ease-out hover:scale-110 [@media(pointer:coarse)]:hidden"
								onClick={() => askToTrade(peer.identity)}
								style={{
									color,
									left: `${Math.max(0, Math.min(100, data.x))}%`,
									top: `${Math.max(0, Math.min(100, data.y))}%`,
									transform: "translate(-2px, -2px)",
								}}
								title="Wallet signature verified"
								type="button"
							>
								<div className="relative">
									<MousePointer2
										className="size-6 -rotate-12 drop-shadow-lg"
										fill="currentColor"
										strokeWidth={1}
									/>
									<div
										className="absolute top-6 left-6 whitespace-nowrap rounded-full px-2 py-1 font-mono text-xs font-medium text-white shadow-lg"
										style={{ backgroundColor: color }}
									>
										{avatarUrl ? (
											<img
												alt=""
												className="mr-1 inline size-4 rounded-full object-cover"
												src={avatarUrl}
											/>
										) : null}
										{name}
									</div>
								</div>
							</button>
						</PeerContextMenu>
					);
				})}
			</div>

			<FloorBar>
				<span className="relative flex size-2 shrink-0">
					<span className="absolute inline-flex size-full rounded-full bg-chart-4 opacity-60 motion-safe:animate-ping" />
					<span className="relative inline-flex size-2 rounded-full bg-chart-4" />
				</span>
				<div className="min-w-0 flex-1 text-left">
					<p className="truncate text-sm font-medium">
						Live floor · {floorCountLabel(peers.length)}
					</p>
					<p className="truncate text-xs text-muted-foreground">
						You're visible as <span className="font-mono">{selfName}</span>
					</p>
				</div>
				<Button
					className="min-h-11 shrink-0"
					onClick={() => setPeersOpen(true)}
					size="sm"
					variant="secondary"
				>
					<Users className="size-4" data-icon="inline-start" />
					Peers
				</Button>
				<Button
					aria-label="Leave the floor"
					className="min-h-11 min-w-11 shrink-0"
					onClick={onLeave}
					size="sm"
					variant="ghost"
				>
					<LogOut className="size-4" />
					<span className="hidden sm:inline">Leave</span>
				</Button>
			</FloorBar>

			<Sheet onOpenChange={setPeersOpen} open={peersOpen}>
				<SheetContent
					className="max-h-[80dvh] rounded-t-2xl sm:mx-auto sm:max-w-xl"
					side="bottom"
				>
					<SheetHeader>
						<SheetTitle>On the floor</SheetTitle>
						<SheetDescription>
							Everyone here signed in with a wallet on the same network as you.
							Pick someone to ask for a trade.
						</SheetDescription>
					</SheetHeader>
					<ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
						{peers.length === 0 ? (
							<li className="px-2 py-6 text-center text-sm text-muted-foreground">
								No one else is here right now. Keep this page open and you'll
								hear a sound when someone asks you to trade.
							</li>
						) : (
							peers.map((peer) => {
								const name = peerName(peer.identity);
								const avatarUrl = peer.identity.profile?.avatarUrl;
								return (
									<li
										className="flex min-h-14 items-center gap-3 rounded-lg px-2"
										key={peer.userId}
									>
										{avatarUrl ? (
											<img
												alt=""
												className="size-8 shrink-0 rounded-full object-cover"
												src={avatarUrl}
											/>
										) : (
											<span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
												<Users className="size-4" />
											</span>
										)}
										<div className="min-w-0 flex-1">
											<p className="truncate text-sm font-medium">{name}</p>
											<p className="truncate font-mono text-xs text-muted-foreground">
												{truncateIdentifier(peer.identity.identityKey)}
											</p>
										</div>
										<Button
											aria-label={`Copy ${name}'s identity key`}
											className="min-h-11 min-w-11"
											onClick={() => copyIdentityKey(peer.identity.identityKey)}
											size="icon"
											variant="ghost"
										>
											<Copy className="size-4" />
										</Button>
										<Button
											className="min-h-11"
											onClick={() => askToTrade(peer.identity)}
											size="sm"
										>
											<ArrowRightLeft
												className="size-4"
												data-icon="inline-start"
											/>
											Trade
										</Button>
									</li>
								);
							})
						)}
					</ul>
				</SheetContent>
			</Sheet>

			<SoundAlertDialog
				onOpenChange={(open) => {
					if (!open && !requesting) setConfirming(null);
				}}
				open={Boolean(confirming)}
				openSound={false}
			>
				<AlertDialogContent className="sm:max-w-md">
					<AlertDialogHeader>
						<AlertDialogTitle>
							Ask {confirming ? peerName(confirming) : ""} to trade?
						</AlertDialogTitle>
						<AlertDialogDescription>
							Your wallet signs the request. They see your identity key and can
							accept or decline. Nothing moves until you both lock offers.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<SoundAlertDialogCancel disabled={requesting}>
							Cancel
						</SoundAlertDialogCancel>
						<SoundAlertDialogAction
							disabled={requesting}
							onClick={(event) => {
								event.preventDefault();
								if (confirming) void sendTradeRequest(confirming);
							}}
						>
							{requesting ? "Sending…" : "Send request"}
						</SoundAlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</SoundAlertDialog>
		</>
	);
}

/** The floor layer: cursors and the floor bar once joined, nothing before. */
export function SharedPresence({ floor }: { floor: LandingFloor }) {
	const { state } = floor;
	if (state.kind === "live" && floor.userId && floor.selfName) {
		return (
			<LiveFloor
				chain={floor.chain}
				key={floor.userId}
				onLeave={floor.leave}
				selfName={floor.selfName}
				userId={floor.userId}
			/>
		);
	}
	if (state.kind === "joining") {
		return (
			<FloorBar>
				<RefreshCw className="size-4 shrink-0 text-muted-foreground motion-safe:animate-spin" />
				<p className="min-h-11 flex-1 content-center text-left text-sm">
					Joining the floor. Approve the signature in your wallet if it asks.
				</p>
			</FloorBar>
		);
	}
	if (state.kind === "error") {
		return (
			<FloorBar>
				<div className="min-w-0 flex-1 text-left">
					<p className="text-sm font-medium">Couldn't join the floor</p>
					<p className="truncate text-xs text-muted-foreground">
						{state.message}
					</p>
				</div>
				<Button className="min-h-11 shrink-0" onClick={floor.retry} size="sm">
					Try again
				</Button>
			</FloorBar>
		);
	}
	if (state.kind === "left") {
		return (
			<FloorBar>
				<p className="min-w-0 flex-1 text-left text-sm text-muted-foreground">
					You left the floor. No one can see you.
				</p>
				<Button className="min-h-11 shrink-0" onClick={floor.rejoin} size="sm">
					Rejoin
				</Button>
			</FloorBar>
		);
	}
	return null;
}
