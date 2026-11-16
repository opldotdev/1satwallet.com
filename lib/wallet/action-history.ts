import {
	type ListActionsResult,
	MerklePath,
	type WalletAction,
	type WalletInterface,
} from "@bsv/sdk";
import {
	isBrc153ReferenceLabel,
	parseBrc153ReferenceLabel,
} from "@bsv/wallet-toolbox-client";

export const ACTION_HISTORY_PAGE_SIZE = 25;

export function actionAmountLabel(satoshis: number): string {
	const sign = satoshis < 0 ? "−" : satoshis > 0 ? "+" : "";
	return `${sign}${(Math.abs(satoshis) / 100_000_000).toFixed(8)} BSV`;
}

export interface ActionHistoryState {
	identityKey: string | null;
	actions: WalletAction[] | null;
	totalActions: number;
	error: string | null;
}

export function actionHistoryForIdentity(
	history: ActionHistoryState,
	identityKey: string | null,
): ActionHistoryState {
	return history.identityKey === identityKey
		? history
		: { identityKey, actions: null, totalActions: 0, error: null };
}

/**
 * One page of history, newest first. `listActions` answers in storage
 * (insertion) order, oldest first, so page N counts back from the end and is
 * reversed, as the iOS app and Yours Wallet read it.
 */
export async function listActionHistoryPage(
	wallet: Pick<WalletInterface, "listActions">,
	page: number,
): Promise<ListActionsResult> {
	const { totalActions } = await wallet.listActions({
		labels: [],
		labelQueryMode: "any",
		limit: 1,
		offset: 0,
	});
	const end = totalActions - page * ACTION_HISTORY_PAGE_SIZE;
	if (end <= 0) return { totalActions, actions: [] };
	const offset = Math.max(0, end - ACTION_HISTORY_PAGE_SIZE);
	const result = await wallet.listActions({
		labels: [],
		labelQueryMode: "any",
		includeLabels: true,
		limit: end - offset,
		offset,
	});
	return {
		totalActions: result.totalActions,
		actions: [...result.actions].reverse(),
	};
}

const PENDING_STATUSES = new Set<WalletAction["status"]>([
	"unprocessed",
	"sending",
	"unproven",
	"unsigned",
]);

/** Broadcast or about to be, not yet in a block (the iOS app's "Unconfirmed"). */
export function isPendingAction(action: Pick<WalletAction, "status">): boolean {
	return PENDING_STATUSES.has(action.status);
}

/**
 * Orders a page newest first by block time, as the iOS app's `newestFirst`
 * does: a row with a known time goes by it, a pending row without one goes on
 * top, and any other row without one keeps its place after the row ahead of
 * it. Ties keep their order.
 */
export function orderActionsNewestFirst(
	actions: WalletAction[],
	times: ReadonlyMap<string, number>,
): WalletAction[] {
	let previous = Number.POSITIVE_INFINITY;
	return actions
		.map((action, index) => {
			const key =
				times.get(action.txid) ??
				(isPendingAction(action) ? Number.POSITIVE_INFINITY : previous);
			previous = key;
			return { action, index, key };
		})
		.sort((a, b) => b.key - a.key || a.index - b.index)
		.map(({ action }) => action);
}

export interface BlockTimeServices {
	beef: { getProof(txid: string): Promise<Uint8Array> };
	chaintracks: {
		findHeaderForHeight(
			height: number,
		): Promise<{ merkleRoot: string; time: number } | undefined>;
	};
}

// Block times do not change once mined; misses are not cached so a later
// look finds a transaction that has since been mined.
const blockTimeCache = new Map<string, number>();

/**
 * When a transaction was mined, in ms, or undefined when the service has no
 * proof for it yet. BRC-100 `listActions` carries no time, so this reads the
 * BRC-74 proof's block height and that block's header, and uses the header
 * only when its merkle root is the one the proof computes for the txid (the
 * iOS app's `BlockTimeService`).
 */
export async function actionBlockTime(
	services: BlockTimeServices,
	txid: string,
): Promise<number | undefined> {
	const cached = blockTimeCache.get(txid);
	if (cached !== undefined) return cached;
	if (!/^[0-9a-f]{64}$/i.test(txid)) return undefined;
	try {
		const path = MerklePath.fromBinary([
			...(await services.beef.getProof(txid)),
		]);
		const header = await services.chaintracks.findHeaderForHeight(
			path.blockHeight,
		);
		if (!header || path.computeRoot(txid) !== header.merkleRoot) {
			return undefined;
		}
		if (!Number.isSafeInteger(header.time) || header.time <= 0) {
			return undefined;
		}
		const time = header.time * 1000;
		blockTimeCache.set(txid, time);
		return time;
	} catch {
		return undefined;
	}
}

/** Block times for a page of actions, a few lookups at a time. */
export async function actionBlockTimes(
	services: BlockTimeServices,
	actions: Pick<WalletAction, "txid" | "status">[],
	concurrency = 4,
): Promise<Map<string, number>> {
	const txids = [
		...new Set(
			actions
				.filter((action) => action.status !== "failed")
				.map((action) => action.txid),
		),
	];
	const times = new Map<string, number>();
	let next = 0;
	const worker = async () => {
		while (next < txids.length) {
			const txid = txids[next++];
			const time = await actionBlockTime(services, txid);
			if (time !== undefined) times.set(txid, time);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(concurrency, txids.length) }, worker),
	);
	return times;
}

const DAY_MS = 86_400_000;

function calendarDay(time: number, timeZone?: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "numeric",
		day: "numeric",
	}).formatToParts(time);
	const part = (type: string) =>
		Number(parts.find((entry) => entry.type === type)?.value);
	return Date.UTC(part("year"), part("month") - 1, part("day")) / DAY_MS;
}

/**
 * How a row's time reads, in the viewer's locale and time zone, following the
 * iOS app's `ActivityDate` row style: "Today, 11:08 AM", "Yesterday, 9:14 PM",
 * the weekday within the week, then "Mar 4" this year or "Mar 4, 2025"
 * before, each with its time.
 */
export function actionDateLabel(
	time: number,
	options: { now?: number; locale?: string; timeZone?: string } = {},
): string {
	const { now = Date.now(), locale, timeZone } = options;
	const clock = new Intl.DateTimeFormat(locale, {
		timeZone,
		hour: "numeric",
		minute: "2-digit",
	}).format(time);
	const daysAgo = calendarDay(now, timeZone) - calendarDay(time, timeZone);
	if (daysAgo === 0) return `Today, ${clock}`;
	if (daysAgo === 1) return `Yesterday, ${clock}`;
	const sameYear =
		new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(
			time,
		) ===
		new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(now);
	const day = new Intl.DateTimeFormat(
		locale,
		daysAgo >= 2 && daysAgo <= 6
			? { timeZone, weekday: "long" }
			: sameYear
				? { timeZone, month: "short", day: "numeric" }
				: { timeZone, month: "short", day: "numeric", year: "numeric" },
	).format(time);
	return `${day}, ${clock}`;
}

/** The row's time line: its block time, "Pending" before it is mined. */
export function actionTimeLabel(
	action: Pick<WalletAction, "status">,
	time: number | undefined,
	options?: Parameters<typeof actionDateLabel>[1],
): string | undefined {
	if (time !== undefined) return actionDateLabel(time, options);
	return isPendingAction(action) ? "Pending" : undefined;
}

const STATUS_LABELS: Partial<Record<WalletAction["status"], string>> = {
	unprocessed: "Queued",
	sending: "Sending",
	unproven: "Unconfirmed",
	unsigned: "Unsigned",
	nosend: "Not sent",
	nonfinal: "Not final",
	failed: "Failed",
};

/**
 * The row's one status badge, in plain words. A completed (mined) action has
 * none: its date already says it is done.
 */
export function actionStatusLabel(
	action: Pick<WalletAction, "status">,
): string | undefined {
	return STATUS_LABELS[action.status];
}

export function actionReferenceLabel(action: WalletAction): string | undefined {
	return action.labels?.find(
		(label) =>
			isBrc153ReferenceLabel(label) &&
			parseBrc153ReferenceLabel(label) !== undefined,
	);
}

export function ordinaryActionLabels(action: WalletAction): string[] {
	return action.labels?.filter((label) => !isBrc153ReferenceLabel(label)) ?? [];
}

export function actionExplorerUrl(
	txid: string,
	chain: "main" | "test",
): string | undefined {
	if (!/^[0-9a-f]{64}$/i.test(txid)) return undefined;
	const host = chain === "test" ? "test.whatsonchain.com" : "whatsonchain.com";
	return `https://${host}/tx/${txid}`;
}
