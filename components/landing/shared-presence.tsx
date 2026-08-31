"use client";

import usePresence from "@convex-dev/presence/react";
import { useMutation, useQuery } from "convex/react";
import { MousePointer2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useSound } from "@/hooks/use-sound";
import { signP2PCommand } from "@/lib/p2p-auth";
import {
	getWalletPresenceUserId,
	PRESENCE_ANNOUNCEMENT_REFRESH_MS,
	PRESENCE_ROOM_ID,
} from "@/lib/p2p-presence";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import { api } from "../../convex/_generated/api";

interface CursorData {
	x: number;
	y: number;
}

const ROOM_ID = PRESENCE_ROOM_ID;
const HEARTBEAT_INTERVAL = 10_000;
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

export function getPresenceUserId(
	identityKey: string | null,
	anonymousId: string,
	chain: "main" | "test" = "main",
): string {
	const normalizedIdentityKey = identityKey?.toLowerCase();
	return normalizedIdentityKey &&
		/^(02|03)[0-9a-f]{64}$/.test(normalizedIdentityKey)
		? getWalletPresenceUserId(normalizedIdentityKey, chain, anonymousId)
		: `anon:${anonymousId}`;
}

export function getPresenceLabel(
	identityKey: string | null,
	anonymousId: string,
): string {
	return identityKey
		? truncateIdentifier(identityKey)
		: `Guest ${anonymousId.slice(0, 4)}`;
}

function labelForUserId(userId: string): string {
	const parts = userId.split(":");
	const kind = parts[0];
	const id = kind === "wallet" ? (parts[2] ?? "") : (parts[1] ?? "");
	return getPresenceLabel(kind === "wallet" ? id : null, id);
}

function isCursorData(value: unknown): value is CursorData {
	if (!value || typeof value !== "object") return false;
	const data = value as Partial<CursorData>;
	return Number.isFinite(data.x) && Number.isFinite(data.y);
}

function PresenceLayer({
	userId,
	identityKey,
}: {
	userId: string;
	identityKey: string | null;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const lastUpdateRef = useRef(0);
	const updateInFlightRef = useRef(false);
	const presenceState = usePresence(
		api.presence,
		ROOM_ID,
		userId,
		HEARTBEAT_INTERVAL,
	);
	const updateCursor = useMutation(api.presence.updateCursor);
	const sendRequest = useMutation(api.p2p.sendRequest);
	const publicIdentities = useQuery(api.presence.listPublicIdentities, {
		roomId: ROOM_ID,
	});
	const { play } = useSound();
	const { wallet } = useWalletToolbox();
	const [requestingPeer, setRequestingPeer] = useState<string | null>(null);
	const [identityClock, setIdentityClock] = useState(() => Date.now());

	useEffect(() => {
		const timer = setInterval(
			() => setIdentityClock(Date.now()),
			HEARTBEAT_INTERVAL,
		);
		return () => clearInterval(timer);
	}, []);

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
				.catch(() => undefined)
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

	const online = presenceState?.filter((entry) => entry.online) ?? [];
	const cursors = online.filter((entry) => entry.userId !== userId);
	const identityByUserId = new Map(
		(publicIdentities ?? [])
			.filter((identity) => identity.expiresAt > identityClock)
			.map((identity) => [identity.userId, identity]),
	);

	const startTrade = async (peerUserId: string) => {
		const peerIdentity = identityByUserId.get(peerUserId)?.identityKey ?? null;
		if (!wallet || !identityKey) {
			toast.error("Connect and unlock a BRC-100 wallet to initiate a trade.");
			return;
		}
		if (!peerIdentity) {
			toast.error(
				"That visitor needs to connect a wallet before you can trade.",
			);
			return;
		}
		if (requestingPeer) return;
		setRequestingPeer(peerUserId);
		play("click");
		try {
			const requestId = crypto.randomUUID();
			const signed = await signP2PCommand(wallet, "request.create", {
				requestId,
				toIdentity: peerIdentity,
			});
			await sendRequest(signed);
			toast.success(
				`Trade request sent to ${truncateIdentifier(peerIdentity)}.`,
			);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "The trade request failed.",
			);
		}
		setRequestingPeer(null);
	};

	return (
		<div
			ref={containerRef}
			className="relative h-full w-full overflow-hidden pointer-events-none"
		>
			{presenceState && (
				<div
					className="fixed right-4 bottom-4 z-50 flex items-center gap-2 rounded-full border border-primary/20 bg-background/80 px-3 py-1.5 text-sm backdrop-blur-sm"
					role="status"
				>
					<span className="size-2 rounded-full bg-chart-4 motion-safe:animate-pulse" />
					<span className="text-muted-foreground">{online.length} online</span>
				</div>
			)}

			{cursors.map((cursor, index) => {
				const data = isCursorData(cursor.data) ? cursor.data : { x: 50, y: 50 };
				const color = CURSOR_COLORS[index % CURSOR_COLORS.length];
				const publicIdentity = identityByUserId.get(cursor.userId);
				const peerIdentity = publicIdentity?.identityKey ?? null;
				const label = publicIdentity?.label ?? labelForUserId(cursor.userId);
				const profileStatus = publicIdentity?.profile
					? `${publicIdentity.profile.source} profile ${publicIdentity.profile.verification}`
					: "no verified public profile";
				return (
					<button
						aria-label={
							peerIdentity
								? `Start a trade with ${label}`
								: `${label} has unverified presence`
						}
						className="group absolute z-50 hidden border-none bg-transparent p-0 pointer-events-auto md:block motion-safe:transition-[left,top,transform] motion-safe:duration-100 motion-safe:ease-out hover:scale-110"
						disabled={requestingPeer === cursor.userId}
						key={cursor.userId}
						onClick={() => void startTrade(cursor.userId)}
						onContextMenu={(event) => {
							event.preventDefault();
							void startTrade(cursor.userId);
						}}
						style={{
							color,
							left: `${Math.max(0, Math.min(100, data.x))}%`,
							top: `${Math.max(0, Math.min(100, data.y))}%`,
							transform: "translate(-2px, -2px)",
						}}
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
								title={
									publicIdentity
										? `Wallet signature verified; ${profileStatus}`
										: "Wallet identity unverified"
								}
							>
								{label}
								<span className="ml-1 opacity-75">
									{peerIdentity ? "· verified" : "· unverified"}
								</span>
							</div>
							<div
								className="absolute -inset-3 -z-10 rounded-full opacity-0 transition-opacity group-hover:opacity-30"
								style={{ backgroundColor: color }}
							/>
						</div>
					</button>
				);
			})}
		</div>
	);
}

export function SharedPresence() {
	const [anonymousId, setAnonymousId] = useState<string | null>(null);
	const [authenticatedUserId, setAuthenticatedUserId] = useState<string | null>(
		null,
	);
	const announce = useMutation(api.presence.announce);
	const { chain, connectionStatus, identityKey, wallet } = useWalletToolbox();

	useEffect(() => setAnonymousId(crypto.randomUUID()), []);

	useEffect(() => {
		if (!anonymousId || !identityKey || !wallet) {
			setAuthenticatedUserId(null);
			return;
		}
		let cancelled = false;
		let refreshTimer: ReturnType<typeof setTimeout> | undefined;
		const userId = getPresenceUserId(identityKey, anonymousId, chain);
		setAuthenticatedUserId(null);
		const publish = async () => {
			try {
				const signed = await signP2PCommand(wallet, "presence.announce", {
					chain,
					sessionId: anonymousId,
					userId,
				});
				await announce(signed);
				if (!cancelled) setAuthenticatedUserId(userId);
			} catch {
				if (!cancelled) setAuthenticatedUserId(null);
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
	}, [announce, anonymousId, chain, identityKey, wallet]);

	if (
		!process.env.NEXT_PUBLIC_CONVEX_URL ||
		!anonymousId ||
		connectionStatus === "authenticating"
	) {
		return null;
	}
	const expectedWalletUserId = identityKey
		? getPresenceUserId(identityKey, anonymousId, chain)
		: null;
	const userId =
		authenticatedUserId && authenticatedUserId === expectedWalletUserId
			? authenticatedUserId
			: `anon:${anonymousId}`;
	return (
		<PresenceLayer key={userId} userId={userId} identityKey={identityKey} />
	);
}
