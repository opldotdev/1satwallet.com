"use client";

import usePresence from "@convex-dev/presence/react";
import { useMutation } from "convex/react";
import { MousePointer2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import { api } from "../../convex/_generated/api";

interface CursorData {
	x: number;
	y: number;
}

const ROOM_ID = "landing";
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
		? `wallet:${chain}:${normalizedIdentityKey}`
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

function PresenceLayer({ userId }: { userId: string }) {
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
				return (
					<div
						aria-hidden="true"
						className="absolute z-50 hidden md:block motion-safe:transition-[left,top] motion-safe:duration-100 motion-safe:ease-out"
						key={cursor.userId}
						style={{
							color,
							left: `${Math.max(0, Math.min(100, data.x))}%`,
							top: `${Math.max(0, Math.min(100, data.y))}%`,
							transform: "translate(-2px, -2px)",
						}}
					>
						<MousePointer2
							className="size-6 -rotate-12 drop-shadow-lg"
							fill="currentColor"
							strokeWidth={1}
						/>
						<div
							className="absolute top-6 left-6 whitespace-nowrap rounded-full px-2 py-1 font-mono text-xs font-medium text-white shadow-lg"
							style={{ backgroundColor: color }}
						>
							{labelForUserId(cursor.userId)}
						</div>
					</div>
				);
			})}
		</div>
	);
}

export function SharedPresence() {
	const [anonymousId, setAnonymousId] = useState<string | null>(null);
	const { chain, connectionStatus, identityKey } = useWalletToolbox();

	useEffect(() => setAnonymousId(crypto.randomUUID()), []);

	if (
		!process.env.NEXT_PUBLIC_CONVEX_URL ||
		!anonymousId ||
		connectionStatus === "authenticating"
	) {
		return null;
	}
	const userId = getPresenceUserId(identityKey, anonymousId, chain);
	return <PresenceLayer key={userId} userId={userId} />;
}
