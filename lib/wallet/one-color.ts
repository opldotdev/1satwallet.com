/**
 * 1Color (BRC-162) tokens the wallet holds and their history. Port of Yours
 * (yours-org/yours-wallet, branch 1color at 15d1efb): `src/services/oneColor.ts`
 * (holdings, `oneColorActionAmount`) and `fetchOneColorHistory` from
 * `src/utils/coinHistory.ts`; names kept.
 *
 * Holdings come from one read of the toolbox's basket-prefix listing: every
 * output in the color module's per-asset baskets, with its locking script and
 * nothing else. The script is decoded with the OneColor template for its
 * asset, role and amount; an output that is not spendable is reserved. The
 * read reports wallet state only and never asks the overlay.
 *
 * Reserved is the module's word for "not spendable": the output is an input
 * of an action that has not been proven yet. A handoff (`nosend`) is signed
 * but unsent, so its tokens are still ours until the recipient claims it:
 * those are pending. A broadcast transaction (`unproven`, `sending`) has
 * already spent its inputs and its change is listed as available, so counting
 * those inputs would count the same tokens twice.
 *
 * Symbol, decimals and icon live on the asset's deploy output alone, so they
 * are read once per asset from the deploy transaction and cached.
 */
import type { OneSatContext } from "@1sat/actions";
import {
	OneColor,
	type OneColorMetadata,
	type OneColorToken,
} from "@1sat/templates";
import {
	type ActionStatus,
	type ListActionsArgs,
	LockingScript,
	Transaction,
	Utils,
	type WalletAction,
	type WalletInterface,
	type WalletOutput,
} from "@bsv/sdk";
import { sdk } from "@bsv/wallet-toolbox-client";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";

export type OneColorAssetInfo = {
	/** Ticker, not unique; absent when the deploy carries none. */
	sym?: string;
	/** Decimal places, 0-18. */
	dec: number;
	/** The deploy's embedded icon as a data URL, when it is an image. */
	icon?: string;
};

export type OneColorBalance = OneColorAssetInfo & {
	/** `<txid>_<vout>` */
	assetId: string;
	/** Value units spendable now: the balance. */
	available: bigint;
	/** Value units held by unsent sends the recipient has not claimed; not part of the balance. */
	pending: bigint;
	/** Authority outputs held (available + reserved). */
	authorities: number;
};

/** A value output the module reports as reserved, with what it is worth. */
export type ReservedOutput = { outpoint: string; amount: bigint };

export type OneColorHolding = {
	assetId: string;
	available: bigint;
	reservedOutputs: ReservedOutput[];
	authorities: number;
};

export type HoldingOutput = Pick<
	WalletOutput,
	"outpoint" | "lockingScript" | "spendable"
>;

const COLOR_BASKET_PREFIX = "p color ";

/** The basket-prefix listing's own ceiling: it has no paging and refuses a wallet holding more. */
const LISTING_LIMIT = 10_000;

/** Action statuses whose inputs are still the wallet's: signed or built, but not broadcast. */
const UNSENT_STATUSES: ReadonlySet<ActionStatus> = new Set([
	"nosend",
	"unsigned",
	"nonfinal",
]);

/** Decode a locking script as a 1Color output; null for anything else, including bad hex. */
export const decodeOneColor = (
	lockingScriptHex: string | undefined,
): OneColorToken | null => {
	if (!lockingScriptHex) return null;
	try {
		return OneColor.decode(LockingScript.fromHex(lockingScriptHex));
	} catch {
		return null;
	}
};

/** What the lists call a token: its symbol, else a short asset id. */
export const oneColorTicker = (t: { sym?: string; assetId: string }): string =>
	t.sym || `${t.assetId.slice(0, 6)}…${t.assetId.slice(-4)}`;

/**
 * The asset an output belongs to. A deploy output carries no asset id in its
 * script: it is the asset, `<txid>_0`. A fixed-supply deploy is the holder's
 * first value output, an authority deploy (amount 0) its first authority. A
 * deploy must be output 0 (BRC-162; the color module refuses any other, as
 * does iOS `OneColorHoldings.assetIdOf`); one anywhere else is no asset.
 */
const assetIdOf = (
	token: OneColorToken,
	outpoint: string,
): string | undefined => {
	if (token.tokenId) return token.tokenId;
	if (token.role !== "deploy") return undefined;
	const [txid, vout] = outpoint.split(".");
	return vout === "0" ? `${txid}_0` : undefined;
};

/** Group decoded token outputs by asset: available amount, reserved outputs, authority count. */
export const aggregateOneColorHoldings = (
	outputs: HoldingOutput[],
): Map<string, OneColorHolding> => {
	const byAsset = new Map<string, OneColorHolding>();
	for (const o of outputs) {
		const token = decodeOneColor(o.lockingScript);
		const assetId = token && assetIdOf(token, o.outpoint);
		if (!token || !assetId) continue;
		const entry = byAsset.get(assetId) ?? {
			assetId,
			available: 0n,
			reservedOutputs: [],
			authorities: 0,
		};
		const authority =
			token.role === "authority" ||
			(token.role === "deploy" && token.amount === 0n);
		if (authority) entry.authorities += 1;
		else if (!o.spendable)
			entry.reservedOutputs.push({
				outpoint: o.outpoint,
				amount: token.amount,
			});
		else entry.available += token.amount;
		byAsset.set(assetId, entry);
	}
	return byAsset;
};

/** Actions read per page while scanning the history newest first. */
const SCAN_PAGE = 100;
/** A scan stops after this many actions; older history of a busy wallet is not read. */
export const ONE_COLOR_SCAN_MAX = 2000;
const SCAN_MAX = ONE_COLOR_SCAN_MAX;

/**
 * The wallet's actions newest first, at most `SCAN_MAX` of them.
 * `listActions` answers in storage (insertion) order, oldest first, so the
 * total is probed and pages are read backwards from the end. Stop early by
 * leaving the loop. `scan.cut` is set when the cap ends the scan with older
 * actions left unread.
 */
async function* actionsNewestFirst(
	wallet: Pick<WalletInterface, "listActions">,
	include: Omit<ListActionsArgs, "labels" | "limit" | "offset">,
	scan: { cut: boolean } = { cut: false },
): AsyncGenerator<WalletAction> {
	const probe = await wallet.listActions({ labels: [], limit: 1, offset: 0 });
	let end = probe.totalActions;
	let scanned = 0;
	while (end > 0 && scanned < SCAN_MAX) {
		const start = Math.max(0, end - SCAN_PAGE);
		const { actions } = await wallet.listActions({
			labels: [],
			...include,
			limit: end - start,
			offset: start,
		});
		for (let i = actions.length - 1; i >= 0; i--) yield actions[i];
		scanned += end - start;
		end = start;
	}
	scan.cut = end > 0;
}

/**
 * The status of the action spending each outpoint, from the action history
 * newest first (reserved inputs belong to recent actions). Stops as soon as
 * every outpoint is found, or after `SCAN_MAX` actions.
 */
export const findSpendingStatuses = async (
	wallet: Pick<WalletInterface, "listActions">,
	outpoints: Iterable<string>,
): Promise<Map<string, ActionStatus>> => {
	const wanted = new Set(outpoints);
	const found = new Map<string, ActionStatus>();
	if (wanted.size === 0) return found;
	for await (const a of actionsNewestFirst(wallet, { includeInputs: true })) {
		for (const i of a.inputs ?? []) {
			if (wanted.has(i.sourceOutpoint) && !found.has(i.sourceOutpoint))
				found.set(i.sourceOutpoint, a.status);
		}
		if (found.size === wanted.size) break;
	}
	return found;
};

/**
 * The reserved amount still the wallet's: inputs of unsent actions. An
 * outpoint whose spender was not found in the scanned history is treated as
 * pending rather than spent, the side that never hides tokens.
 */
export const pendingAmount = (
	reserved: ReservedOutput[],
	statuses: Map<string, ActionStatus>,
): bigint =>
	reserved.reduce((sum, r) => {
		const status = statuses.get(r.outpoint);
		return status === undefined || UNSENT_STATUSES.has(status)
			? sum + r.amount
			: sum;
	}, 0n);

/**
 * Every token output the color module holds, across all assets: one call to
 * the toolbox's basket-prefix listing, which returns every output in the
 * `p color` baskets whatever page is asked for. Only locking scripts are read.
 * Call it on the raw wallet: the website's action context wraps `listOutputs`
 * to merge legacy basket names, which this listing has none of.
 */
export const listOneColorHoldings = async (
	wallet: Pick<WalletInterface, "listOutputs">,
): Promise<HoldingOutput[]> => {
	const { outputs } = await wallet.listOutputs({
		basket: sdk.specOpBasketPrefixOutputs,
		tags: [COLOR_BASKET_PREFIX.trim()],
		include: "locking scripts",
		limit: LISTING_LIMIT,
	});
	return outputs.map(({ outpoint, lockingScript, spendable }) => ({
		outpoint,
		lockingScript,
		spendable,
	}));
};

/** The deploy's display fields as the list shows them. */
export const assetInfoFromMetadata = (
	meta: OneColorMetadata | undefined,
): OneColorAssetInfo => {
	const info: OneColorAssetInfo = { dec: meta?.dec ?? 0 };
	if (meta?.sym) info.sym = meta.sym;
	const icon = meta?.icon;
	if (icon && icon.bytes.length > 0 && /^image\//.test(icon.mediaType)) {
		info.icon = `data:${icon.mediaType};base64,${Utils.toBase64(Array.from(icon.bytes))}`;
	}
	return info;
};

/** A well-formed asset id whose output is not a 1Color deploy: not a token, so not worth retrying. */
export class NotOneColorDeployError extends Error {
	constructor(readonly assetId: string) {
		super(`${assetId}: output is not a 1Color deploy`);
		this.name = "NotOneColorDeployError";
	}
}

const assetInfoCache = new Map<string, Promise<OneColorAssetInfo>>();

/**
 * Symbol, decimals and icon for an asset, read from its deploy output. A
 * failed read rejects and is not cached, so the next listing retries.
 */
export const getOneColorAssetInfo = (
	ctx: Pick<OneSatContext, "chain" | "services">,
	assetId: string,
): Promise<OneColorAssetInfo> => {
	const key = `${ctx.chain}:${assetId}`;
	let p = assetInfoCache.get(key);
	if (!p) {
		p = (async () => {
			const [txid, voutText] = assetId.split("_");
			const vout = Number(voutText);
			if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isInteger(vout))
				throw new Error(`${assetId}: not a 1Color asset id`);
			if (!ctx.services)
				throw new Error(`${assetId}: no services to read the deploy`);
			const raw = await ctx.services.beef.getRawTx(txid);
			const tx = Transaction.fromBinary(Array.from(raw));
			const script = tx.outputs[vout]?.lockingScript;
			const token = script ? OneColor.decode(script) : null;
			if (token?.role !== "deploy") throw new NotOneColorDeployError(assetId);
			return assetInfoFromMetadata(token.metadata);
		})();
		p.catch(() => assetInfoCache.delete(key));
		assetInfoCache.set(key, p);
	}
	return p;
};

/**
 * The wallet's 1Color balances, one per asset held, with display fields. An
 * asset whose deploy cannot be read is listed with 0 decimals and no symbol;
 * the failure is logged in full.
 */
export const getOneColorBalances = async (
	ctx: OneSatContext,
): Promise<OneColorBalance[]> => {
	const holdings = [
		...aggregateOneColorHoldings(
			await listOneColorHoldings(ctx.wallet),
		).values(),
	];
	const statuses = await findSpendingStatuses(
		ctx.wallet,
		holdings.flatMap((h) => h.reservedOutputs.map((r) => r.outpoint)),
	);
	return Promise.all(
		holdings.map(async ({ reservedOutputs, ...h }) => {
			let info: OneColorAssetInfo = { dec: 0 };
			try {
				info = await getOneColorAssetInfo(ctx, h.assetId);
			} catch (error) {
				console.error(`[1color] deploy of ${h.assetId} not readable:`, error);
				reportDiagnostic({
					category: "provider",
					code: "provider.failed",
					operation: "wallet.1color.asset-info",
					recoverable: true,
					context: { retryable: true },
				});
			}
			return {
				...h,
				pending: pendingAmount(reservedOutputs, statuses),
				...info,
			};
		}),
	);
};

export type OneColorDirection = "sent" | "received" | "transfer";

export type OneColorActionAmount = {
	direction: OneColorDirection;
	/** Value units that moved; 0 for a transfer. */
	amount: bigint;
};

/** OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG, and nothing else. */
const isP2pkh = (lock: LockingScript): boolean => {
	const c = lock.chunks;
	return (
		c.length === 5 &&
		c[0].op === 0x76 &&
		c[1].op === 0xa9 &&
		c[2].data?.length === 20 &&
		c[3].op === 0x88 &&
		c[4].op === 0xac
	);
};

/**
 * What one wallet action did with an asset, from its decoded inputs and
 * outputs (`listActions` with locking scripts). Value outputs filed in a
 * `p color` basket are this wallet's. Inputs are this wallet's when their
 * lock is P2PKH: the module only ever holds tokens behind P2PKH, while a
 * covenant such as an AMM pool is somebody else's output even though this
 * wallet may have signed the transaction. The amount is the net of what came
 * to us and what left us; outputs to others are not counted. A deploy at
 * this action's own output 0 counts as the asset arriving, and spending that
 * deploy output counts as the asset leaving. `null` when the action touches
 * no output of the asset.
 */
export const oneColorActionAmount = (
	action: Pick<WalletAction, "txid" | "inputs" | "outputs">,
	assetId: string,
): OneColorActionAmount | null => {
	let toUs = 0n;
	let fromUs = 0n;
	let involved = false;
	for (const o of action.outputs ?? []) {
		const t = decodeOneColor(o.lockingScript);
		if (!t || assetIdOf(t, `${action.txid}.${o.outputIndex}`) !== assetId)
			continue;
		involved = true;
		if (t.role === "authority") continue;
		if (o.basket?.startsWith(COLOR_BASKET_PREFIX)) toUs += t.amount;
	}
	for (const i of action.inputs ?? []) {
		const t = decodeOneColor(i.sourceLockingScript);
		if (!t || assetIdOf(t, i.sourceOutpoint) !== assetId) continue;
		involved = true;
		if (t.role !== "authority" && isP2pkh(t.lock)) fromUs += t.amount;
	}
	if (!involved) return null;
	const net = toUs - fromUs;
	if (net > 0n) return { direction: "received", amount: net };
	if (net < 0n) return { direction: "sent", amount: -net };
	return { direction: "transfer", amount: 0n };
};

export type OneColorHistoryEntry = OneColorActionAmount & {
	action: WalletAction;
};

export const ONE_COLOR_HISTORY_PAGE = 25;

export type OneColorHistoryPage = {
	entries: OneColorHistoryEntry[];
	/** The scan hit `ONE_COLOR_SCAN_MAX` with older actions left unread. */
	truncated: boolean;
};

/**
 * One page of an asset's history, newest first: `limit` matching actions
 * after skipping `offset` of them. 1Color actions carry their BRC-207 plan as
 * hex chunks in their labels, with no per-asset label to query by, so the
 * wallet's actions are read newest first with their locking scripts and each
 * is decoded for the asset (Yours `fetchOneColorHistory`). Read it through
 * the permissions manager, which decrypts the descriptions it wrote.
 */
export const fetchOneColorHistory = async (
	wallet: Pick<WalletInterface, "listActions">,
	assetId: string,
	{ offset = 0, limit = ONE_COLOR_HISTORY_PAGE } = {},
): Promise<OneColorHistoryPage> => {
	const matches: OneColorHistoryEntry[] = [];
	const scan = { cut: false };
	if (limit <= 0) return { entries: matches, truncated: false };
	for await (const action of actionsNewestFirst(
		wallet,
		{
			includeOutputs: true,
			includeOutputLockingScripts: true,
			includeInputs: true,
			includeInputSourceLockingScripts: true,
		},
		scan,
	)) {
		const moved = oneColorActionAmount(action, assetId);
		if (moved) matches.push({ ...moved, action });
		if (matches.length >= offset + limit) break;
	}
	return {
		entries: matches.slice(offset, offset + limit),
		truncated: scan.cut,
	};
};
