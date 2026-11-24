/**
 * Swaps this browser has signed or built but not yet taken in. Kept in
 * localStorage per wallet, so a swap that lands after a reload, a lost reply
 * or an expired session is still found on chain and its receipts are added
 * to the wallet. Holds only public data: the session terms and the unsigned
 * swap transaction.
 */
import { reportFailure } from "../runtime-diagnostics";
import type { SwapSession, SwapSettlementView } from "./wallet";
import type { SwapSide } from "./wire";

export interface PendingSwap {
	identityKey: string;
	me: SwapSide;
	session: SwapSession;
	settlement: SwapSettlementView;
	savedAt: number;
}

const PREFIX = "1sat-p2p-swap-pending:";
/** A swap whose inputs have not moved in this long is dropped. */
export const PENDING_SWAP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key"> & {
	readonly length: number;
};

function report(operation: string, error: unknown) {
	reportFailure(
		{
			category: "action",
			code: "action.failed",
			operation: `p2p-swap.${operation}`,
			recoverable: true,
		},
		error,
	);
}

function local(): Store | null {
	try {
		return window.localStorage;
	} catch (error) {
		report("pending-storage", error);
		return null;
	}
}

function key(identityKey: string, sessionId: string) {
	return `${PREFIX}${identityKey}:${sessionId}`;
}

/** Throws when the record can't be kept, so nothing is signed without one. */
export function savePendingSwap(
	pending: PendingSwap,
	store: Store | null = local(),
) {
	if (!store) throw new Error("This browser can't keep a swap record.");
	store.setItem(
		key(pending.identityKey, pending.session.sessionId),
		JSON.stringify(pending),
	);
}

export function clearPendingSwap(
	identityKey: string,
	sessionId: string,
	store: Store | null = local(),
) {
	store?.removeItem(key(identityKey, sessionId));
}

export function listPendingSwaps(
	identityKey: string,
	now = Date.now(),
	store: Store | null = local(),
): PendingSwap[] {
	if (!store) return [];
	const prefix = `${PREFIX}${identityKey}:`;
	const found: PendingSwap[] = [];
	const stale: string[] = [];
	for (let index = 0; index < store.length; index++) {
		const name = store.key(index);
		if (!name?.startsWith(prefix)) continue;
		try {
			const pending = JSON.parse(store.getItem(name) ?? "") as PendingSwap;
			if (
				pending.identityKey !== identityKey ||
				!pending.settlement?.candidate?.txHex ||
				now - pending.savedAt > PENDING_SWAP_TTL_MS
			) {
				stale.push(name);
				continue;
			}
			found.push(pending);
		} catch (error) {
			report("pending-read", error);
			stale.push(name);
		}
	}
	for (const name of stale) store.removeItem(name);
	return found;
}
