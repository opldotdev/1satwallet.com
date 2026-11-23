/**
 * The landing page's live P2P trading floor: who is on it, and what a visitor
 * sees before they are. Nobody joins, appears or sees anyone until a wallet is
 * connected and unlocked; then the wallet signs its presence and the floor
 * shows the peers on the same network.
 */
import type { WalletConnectionStatus } from "@/lib/wallet-connection-status";

export type FloorState =
	/** This build has no live relay (no Convex URL). */
	| { kind: "unavailable" }
	/** No wallet connected: not on the floor, sees no one. */
	| { kind: "signed-out"; hasBuiltInWallet: boolean }
	/** A wallet is chosen but locked or waiting for approval. */
	| { kind: "locked" }
	/** The wallet is connecting or signing its presence. */
	| { kind: "joining" }
	| { kind: "live" }
	/** The user left the floor in this tab. */
	| { kind: "left" }
	| { kind: "error"; message: string };

export function landingFloorState(input: {
	convexConfigured: boolean;
	connectionStatus: WalletConnectionStatus;
	hasIdentity: boolean;
	hasBuiltInWallet: boolean;
	isBuiltInWalletLocked: boolean;
	left: boolean;
	announce: "pending" | "ok" | { error: string };
}): FloorState {
	if (!input.convexConfigured) return { kind: "unavailable" };
	if (input.connectionStatus === "authenticating") return { kind: "joining" };
	if (input.connectionStatus !== "ready" || !input.hasIdentity) {
		if (
			input.connectionStatus === "locked" ||
			input.connectionStatus === "authorization-required" ||
			(input.hasBuiltInWallet && input.isBuiltInWalletLocked)
		) {
			return { kind: "locked" };
		}
		return { kind: "signed-out", hasBuiltInWallet: input.hasBuiltInWallet };
	}
	if (input.left) return { kind: "left" };
	if (input.announce === "pending") return { kind: "joining" };
	if (input.announce === "ok") return { kind: "live" };
	return { kind: "error", message: input.announce.error };
}

/** A presence user id's network: "wallet:<chain>:<key>:<session>". */
export function presenceChain(userId: string): "main" | "test" | null {
	const [kind, chain] = userId.split(":");
	if (kind !== "wallet") return null;
	return chain === "main" || chain === "test" ? chain : null;
}

export interface FloorEntry<Identity> {
	userId: string;
	online: boolean;
	data?: unknown;
	identity?: Identity | null;
}

/**
 * The peers to show: online, signed in on the same network, not this tab, and
 * one entry per wallet (a wallet open in two tabs is one peer).
 */
export function floorPeers<Identity extends { identityKey: string }>(
	entries: readonly FloorEntry<Identity>[] | undefined,
	self: { userId: string; identityKey: string; chain: "main" | "test" },
): (FloorEntry<Identity> & { identity: Identity })[] {
	const seen = new Set<string>([self.identityKey]);
	const peers: (FloorEntry<Identity> & { identity: Identity })[] = [];
	for (const entry of entries ?? []) {
		if (!entry.online || entry.userId === self.userId) continue;
		if (presenceChain(entry.userId) !== self.chain) continue;
		const identity = entry.identity;
		if (!identity || seen.has(identity.identityKey)) continue;
		seen.add(identity.identityKey);
		peers.push({ ...entry, identity });
	}
	return peers;
}

export function floorCountLabel(peerCount: number): string {
	if (peerCount === 0) return "No one else here yet";
	return peerCount === 1 ? "1 peer here" : `${peerCount} peers here`;
}

/** Marks that the user left the floor in this tab; Rejoin clears it. */
export const FLOOR_LEFT_KEY = "1sat-floor-left";

type SessionFlags = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function sessionFlags(): SessionFlags | null {
	try {
		return window.sessionStorage;
	} catch (error) {
		console.warn(
			"[p2p-floor] sessionStorage is not readable; Leave lasts until reload",
			error instanceof Error ? error.message : String(error),
		);
		return null;
	}
}

export function readFloorLeft(storage: SessionFlags | null = sessionFlags()) {
	try {
		return storage?.getItem(FLOOR_LEFT_KEY) === "1";
	} catch (error) {
		console.warn(
			"[p2p-floor] could not read the left-the-floor flag",
			error instanceof Error ? error.message : String(error),
		);
		return false;
	}
}

export function writeFloorLeft(
	left: boolean,
	storage: SessionFlags | null = sessionFlags(),
) {
	try {
		if (left) storage?.setItem(FLOOR_LEFT_KEY, "1");
		else storage?.removeItem(FLOOR_LEFT_KEY);
	} catch (error) {
		console.warn(
			"[p2p-floor] could not save the left-the-floor flag",
			error instanceof Error ? error.message : String(error),
		);
	}
}
