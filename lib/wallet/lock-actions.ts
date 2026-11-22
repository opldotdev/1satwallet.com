import type { OneSatContext } from "@1sat/actions";
import { listLocks, lockBsv, unlockBsv } from "@1sat/actions";
import { readAssetIdTag } from "@1sat/types";

/** Ten-minute blocks in a day; the iOS app's default lock length. */
export const BLOCKS_PER_DAY = 144;
/** nLockTime values at or above this are read as Unix time, not block height. */
export const LOCKTIME_THRESHOLD = 500_000_000;

const BLOCK_NUMBER = /^[1-9]\d{0,9}$/;
const UNTIL_TAG = /^until:(\d+)$/;

export interface LockedCoin {
	/** Wallet tracking id (`id:` tag); unlock needs it. */
	id: string | null;
	outpoint: string;
	satoshis: number;
	until: number;
	spendable: boolean;
}

export type LockHeightMode = "height" | "blocks";

export interface LockActionSet {
	list: typeof listLocks.execute;
	lock: typeof lockBsv.execute;
	unlock: typeof unlockBsv.execute;
}

export const canonicalLockActions: LockActionSet = {
	list: listLocks.execute,
	lock: lockBsv.execute,
	unlock: unlockBsv.execute,
};

/** A positive whole number of blocks, or null. */
export function parseBlockNumber(value: string): number | null {
	const normalized = value.trim();
	if (!BLOCK_NUMBER.test(normalized)) return null;
	const parsed = Number(normalized);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

/** The unlock height for a typed block height or a typed duration in blocks. */
export function resolveLockUntil(
	mode: LockHeightMode,
	value: string,
	currentHeight: number,
): number | null {
	const parsed = parseBlockNumber(value);
	if (parsed === null) return null;
	return mode === "blocks" ? currentHeight + parsed : parsed;
}

/** Rough wall-clock length of `blocks` ten-minute blocks. */
export function approximateBlockDuration(blocks: number): string {
	if (blocks < 6) return "under an hour";
	if (blocks < BLOCKS_PER_DAY) {
		const hours = Math.round(blocks / 6);
		return `about ${hours} hour${hours === 1 ? "" : "s"}`;
	}
	const days = Math.round(blocks / BLOCKS_PER_DAY);
	return `about ${days.toLocaleString("en-US")} day${days === 1 ? "" : "s"}`;
}

/** The first problem with a lock request, as a plain sentence, or null. */
export function lockRequestProblem(input: {
	satoshis: number | null;
	until: number | null;
	currentHeight: number;
	spendable?: number | null;
}): string | null {
	const { satoshis, until, currentHeight, spendable } = input;
	if (satoshis === null || !Number.isSafeInteger(satoshis) || satoshis <= 0) {
		return "Enter a positive BSV amount with no more than 8 decimals.";
	}
	if (
		typeof spendable === "number" &&
		Number.isSafeInteger(spendable) &&
		satoshis > spendable
	) {
		return "The amount is more than your spendable balance.";
	}
	if (until === null || !Number.isSafeInteger(until) || until <= 0) {
		return "Enter a whole number of blocks.";
	}
	if (until <= currentHeight) {
		return `Pick a block after the current height, ${currentHeight}.`;
	}
	if (until >= LOCKTIME_THRESHOLD) {
		return `The unlock block must be below ${LOCKTIME_THRESHOLD}.`;
	}
	return null;
}

/** Shown when the network refuses an unlock as not final yet. */
export const LOCK_NOT_FINAL_YET =
	"The network hasn't reached this unlock block yet. Nothing was unlocked; try again after the next block.";

// Error codes returned by @1sat/actions lockBsv/unlockBsv as `result.error`.
const LOCK_ERROR_MESSAGES: Record<string, string> = {
	"no-lock-requests": "Enter an amount and an unlock block.",
	"invalid-satoshis": "Enter a positive BSV amount.",
	"invalid-block-height": "Enter a valid unlock block.",
	"lock-script-encode-failed":
		"The lock could not be built for that block height. Nothing was locked.",
	"no-txid-returned":
		"The wallet did not return a transaction id. Check History before trying again.",
	"services-required":
		"Lock services aren't available for this wallet connection.",
	"no-matured-locks":
		"None of these coins can be unlocked yet. Refresh and try again.",
	"no-beef-available":
		"The locked coin's transaction could not be loaded. Try again shortly.",
	"locks-missing-id-or-ci":
		"This wallet can't unlock these coins: they have no wallet tracking record.",
	"lock-not-spendable":
		"That coin isn't unlockable yet. Refresh and try again.",
	"lock-ids-required": "Pick a coin to unlock.",
};

export function lockActionFailureMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.trim().toLowerCase();
	const known = LOCK_ERROR_MESSAGES[normalized];
	if (known) return known;
	if (
		normalized.includes("denied") ||
		normalized.includes("reject") ||
		normalized.includes("cancel") ||
		normalized.includes("declined")
	) {
		return "The wallet declined this action. Nothing was changed.";
	}
	if (
		normalized.includes("insufficient") ||
		normalized.includes("not enough")
	) {
		return "The wallet does not have enough spendable BSV for this amount and its fee.";
	}
	// The broadcaster's node hasn't reached the unlock block yet, though the
	// wallet's chain tip has (nLockTime is the lock's block).
	if (normalized.includes("transaction is not final")) {
		return LOCK_NOT_FINAL_YET;
	}
	return "The lock action failed. Check the wallet connection and try again.";
}

/** Lock coins in the wallet's `lock` basket, soonest unlock first. */
export async function listLockedCoins(
	ctx: OneSatContext,
	currentHeight: number,
	actions: LockActionSet = canonicalLockActions,
): Promise<LockedCoin[]> {
	const { outputs } = await actions.list(ctx, {
		includeTags: true,
		limit: 10000,
	});
	return outputs
		.flatMap((output) => {
			const tag = output.tags?.map((t) => UNTIL_TAG.exec(t)).find(Boolean);
			if (!tag) return [];
			const until = Number(tag[1]);
			if (!Number.isSafeInteger(until)) return [];
			return [
				{
					id: readAssetIdTag(output.tags) ?? null,
					outpoint: output.outpoint,
					satoshis: output.satoshis,
					until,
					spendable: until <= currentHeight,
				},
			];
		})
		.sort((a, b) => a.until - b.until);
}

/** Lock `satoshis` until block `until`. Throws an action error code on failure. */
export async function executeLock(
	ctx: OneSatContext,
	input: { satoshis: number; until: number; currentHeight: number },
	actions: LockActionSet = canonicalLockActions,
): Promise<string> {
	if (!Number.isSafeInteger(input.satoshis) || input.satoshis <= 0) {
		throw new Error("invalid-satoshis");
	}
	if (
		lockRequestProblem({
			satoshis: input.satoshis,
			until: input.until,
			currentHeight: input.currentHeight,
		})
	) {
		throw new Error("invalid-block-height");
	}
	const result = await actions.lock(ctx, {
		requests: [{ satoshis: input.satoshis, until: input.until }],
	});
	if (result.error) throw new Error(result.error);
	if (!result.txid) throw new Error("no-txid-returned");
	return result.txid;
}

/** Unlock the given spendable coins by tracking id. Throws an action error code on failure. */
export async function executeUnlock(
	ctx: OneSatContext,
	coins: LockedCoin[],
	actions: LockActionSet = canonicalLockActions,
): Promise<string> {
	if (coins.length === 0) throw new Error("lock-ids-required");
	if (coins.some((coin) => !coin.spendable)) {
		throw new Error("lock-not-spendable");
	}
	const ids = coins.map((coin) => coin.id);
	if (ids.some((id) => !id)) throw new Error("locks-missing-id-or-ci");
	const result = await actions.unlock(ctx, { ids: ids as string[] });
	if (result.error) throw new Error(result.error);
	if (!result.txid) throw new Error("no-txid-returned");
	return result.txid;
}
