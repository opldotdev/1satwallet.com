import {
	bsv21FieldsFromOutput,
	createContext,
	deriveDepositAddresses,
	executeTrackedAction,
	FUNDING_BASKET,
	type OneSatContext,
	sendAllBsv,
	sendBsv21,
} from "@1sat/actions";
import { BSV20 } from "@1sat/templates";
import {
	BSOCIAL_BASKET,
	BSV20_BASKET,
	BSV21_BASKET,
	DEPOSIT_BASKET,
	LOCK_BASKET,
	ONESAT_BASKET,
	OPNS_BASKET,
	ORDLOCK_V2_TAG,
	SIGMA_BASKET,
} from "@1sat/types";
import {
	Beef,
	P2PKH,
	PrivateKey,
	ProtoWallet,
	type WalletInterface,
	type WalletOutput,
} from "@bsv/sdk";
import { HOSTING_BASKET, legacyBasketsFor } from "@/lib/wallet/legacy-baskets";

/**
 * Moving what the pay-key-rooted BRC-100 wallet holds to the identity root.
 *
 * Wallet storage is per identity key, so once the built-in wallet is re-rooted
 * at the identity key, nothing the pay-key wallet held (BSV, ordinals, tokens,
 * cancelled listings) is visible any more. Before the re-root, the first-run
 * migration moves every output it holds to the identity root's deposit
 * address: `deriveDepositAddresses` (P1SAT `[0,'onesat']`, keyID "1sat 0",
 * counterparty self) run against the identity key. The identity wallet's
 * `syncAddresses` scans that address under both `[0,'onesat']` and
 * `[0,'p 1sat']` and `internalizeBeef` files ordinals and tokens into their
 * asset baskets and plain BSV into the deposit basket, then funding.
 *
 * Nothing about how any key or address is derived or detected changes here.
 */

/** Toolbox change basket: where the wallet's spendable BSV sits. */
export const CHANGE_BASKET = "default";

/** Outputs per move transaction. */
export const TRANSFER_CHUNK_SIZE = 25;

const P2PKH_UNLOCK_LENGTH = 108;
const LIST_PAGE = 100;

type Kind = "bsv" | "ordinal" | "bsv21" | "bsv20" | "stuck";

/** Every basket the pay-key wallet can hold value in, current and legacy names. */
const BASKET_KINDS: Readonly<Record<string, Kind>> = {
	[CHANGE_BASKET]: "bsv",
	[FUNDING_BASKET]: "bsv",
	[DEPOSIT_BASKET]: "bsv",
	[ONESAT_BASKET]: "ordinal",
	[OPNS_BASKET]: "ordinal",
	[BSV21_BASKET]: "bsv21",
	[BSV20_BASKET]: "bsv20",
	[LOCK_BASKET]: "stuck",
	[SIGMA_BASKET]: "stuck",
	[BSOCIAL_BASKET]: "stuck",
	[HOSTING_BASKET]: "stuck",
};

/** Every basket name read, with the kind of output it holds. */
export function transferBaskets(): { basket: string; kind: Kind }[] {
	const out: { basket: string; kind: Kind }[] = [];
	for (const [basket, kind] of Object.entries(BASKET_KINDS)) {
		out.push({ basket, kind });
		for (const legacy of legacyBasketsFor(basket)) {
			// sendBsv21 reads the current bsv21 basket only, so tokens under an
			// older basket name have no way out here.
			out.push({
				basket: legacy,
				kind: kind === "bsv21" ? "stuck" : kind,
			});
		}
	}
	return out;
}

export interface Holding {
	basket: string;
	kind: Kind;
	output: WalletOutput;
	beef?: number[];
}

/** An output still in the pay-key wallet after the transfer. */
export interface LeftOutput {
	basket: string;
	outpoint: string;
	reason: string;
}

/** Thrown when anything is left: the wallet must not be re-rooted. */
export class PayKeyTransferIncompleteError extends Error {
	readonly left: LeftOutput[];
	readonly transferTxids: string[];
	readonly errors: string[];
	/** Listing cancels that went through earlier in the same run. */
	cancelTxids: string[] = [];
	constructor(left: LeftOutput[], transferTxids: string[], errors: string[]) {
		super(describeLeft(left, transferTxids));
		this.name = "PayKeyTransferIncompleteError";
		this.left = left;
		this.transferTxids = transferTxids;
		this.errors = errors;
	}
}

function describeLeft(left: LeftOutput[], txids: string[]): string {
	const byBasket = new Map<string, LeftOutput[]>();
	for (const item of left) {
		const list = byBasket.get(item.basket) ?? [];
		list.push(item);
		byBasket.set(item.basket, list);
	}
	const parts = [...byBasket].map(([basket, items]) => {
		const reasons = [...new Set(items.map((i) => i.reason))].join("; ");
		const shown = items
			.slice(0, 3)
			.map((i) => i.outpoint)
			.join(", ");
		const more = items.length > 3 ? ` and ${items.length - 3} more` : "";
		return `${items.length} in "${basket}" (${shown}${more}): ${reasons}`;
	});
	const moved =
		txids.length > 0
			? ` ${txids.length} transfer transaction${txids.length !== 1 ? "s" : ""} already sent to the identity wallet: ${txids.join(", ")}.`
			: "";
	return `Your wallet was not switched to the identity key, because ${left.length} output${left.length !== 1 ? "s" : ""} could not be moved out of the current wallet: ${parts.join(" | ")}.${moved} Everything is still in the current wallet.`;
}

/**
 * The identity root's deposit address: `deriveDepositAddresses` (index 0,
 * default prefix "1sat", `[0,'onesat']`, counterparty self) against a wallet
 * rooted at the identity key, the address the identity wallet syncs.
 */
export async function identityDepositAddress(
	identityWif: string,
	chain: "main" | "test",
): Promise<string> {
	const keyWallet = new ProtoWallet(
		PrivateKey.fromWif(identityWif),
	) as unknown as WalletInterface;
	const { derivations } = await deriveDepositAddresses.execute(
		createContext(keyWallet, { chain }),
		{ startIndex: 0, count: 1 },
	);
	const address = derivations[0]?.address;
	if (!address) {
		throw new Error("Could not derive the identity wallet's deposit address");
	}
	return address;
}

function toArray(beef: WalletOutput[] | number[] | Uint8Array | undefined) {
	if (!beef) return undefined;
	return Array.from(beef as ArrayLike<number>);
}

/** Every spendable output in every basket, paged in full. */
export async function readHoldings(
	wallet: WalletInterface,
	withBeef = true,
): Promise<Holding[]> {
	const holdings: Holding[] = [];
	for (const { basket, kind } of transferBaskets()) {
		let offset = 0;
		for (;;) {
			const page = await wallet.listOutputs({
				basket,
				limit: LIST_PAGE,
				offset,
				includeTags: true,
				includeCustomInstructions: true,
				...(withBeef ? { include: "entire transactions" as const } : {}),
			});
			const beef = toArray(page.BEEF as number[] | undefined);
			for (const output of page.outputs) {
				if (output.spendable === false) continue;
				holdings.push({ basket, kind, output, beef });
			}
			offset += page.outputs.length;
			if (page.outputs.length === 0 || offset >= page.totalOutputs) break;
		}
	}
	return holdings;
}

const LISTING_TAGS = new Set(["ordlock", ORDLOCK_V2_TAG]);

function isListed(output: WalletOutput): boolean {
	return (output.tags ?? []).some((tag) => LISTING_TAGS.has(tag));
}

function tagValue(output: WalletOutput, prefix: string): string | undefined {
	return output.tags
		?.find((tag) => tag.startsWith(prefix))
		?.slice(prefix.length);
}

function readCi(output: WalletOutput): Record<string, unknown> {
	if (!output.customInstructions) return {};
	try {
		const parsed = JSON.parse(output.customInstructions);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * Tick and amount of a BSV-20 output in the wallet, or null when either is
 * unknown. Tags first (`bsv20:`/`amt:`, written by sweepBsv20), then the
 * customInstructions sweepBsv20 records.
 */
export function bsv20Fields(
	output: WalletOutput,
): { tick: string; amt: bigint } | null {
	const ci = readCi(output);
	const tick =
		tagValue(output, "bsv20:") ??
		(typeof ci.tick === "string" ? ci.tick : undefined);
	const amtText =
		tagValue(output, "amt:") ??
		(typeof ci.amt === "string" || typeof ci.amt === "number"
			? String(ci.amt)
			: undefined);
	if (!tick || !amtText || !/^[1-9]\d*$/.test(amtText)) return null;
	return { tick, amt: BigInt(amtText) };
}

function isBsv20Ordinal(output: WalletOutput): boolean {
	return (
		tagValue(output, "type:") === "application/bsv-20" ||
		tagValue(output, "bsv20:") !== undefined
	);
}

/** A BSV-21 token output filed under an ordinal basket. */
function isBsv21Ordinal(output: WalletOutput): boolean {
	return (
		(output.tags ?? []).some((tag) => tag.toLowerCase().startsWith("bsv21:")) ||
		typeof readCi(output).id === "string"
	);
}

function atomicAmount(text: string | undefined): bigint | null {
	return text && /^\d+$/.test(text) ? BigInt(text) : null;
}

/** One move: spend each source, pay each output, nothing else but fees. */
export interface MoveRequest {
	description: string;
	sources: Holding[];
	outputs: { lockingScript: string; satoshis: number }[];
}

export interface PayKeyTransferActions {
	move: (
		wallet: WalletInterface,
		request: MoveRequest,
	) => Promise<{ txid?: string; error?: string }>;
	sendBsv21: typeof sendBsv21.execute;
	sendAllBsv: typeof sendAllBsv.execute;
}

function mergeSourceBeef(sources: Holding[]): number[] | undefined {
	const parts = sources.flatMap((s) => (s.beef?.length ? [s.beef] : []));
	if (parts.length === 0) return undefined;
	const unique = [...new Set(parts)];
	if (unique.length === 1) return unique[0];
	const beef = new Beef();
	for (const part of unique) beef.mergeBeef(part);
	return beef.toBinary();
}

/**
 * Spend wallet outputs through the shared createAction pipeline, which signs
 * each input from its record's customInstructions. Wallet change funds the fee.
 */
export async function moveWalletOutputs(
	wallet: WalletInterface,
	request: MoveRequest,
): Promise<{ txid?: string; error?: string }> {
	const inputBEEF = mergeSourceBeef(request.sources);
	const result = await executeTrackedAction(
		wallet,
		{
			description: request.description,
			...(inputBEEF ? { inputBEEF } : {}),
			inputs: request.sources.map((s) => ({
				outpoint: s.output.outpoint,
				inputDescription: "Move to identity wallet",
				unlockingScriptLength: P2PKH_UNLOCK_LENGTH,
			})),
			outputs: request.outputs.map((o) => ({
				lockingScript: o.lockingScript,
				satoshis: o.satoshis,
				outputDescription: "Identity wallet deposit",
			})),
			options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
		},
		undefined,
		inputBEEF,
		undefined,
		{
			spends: request.sources.map((s) => ({
				outpoint: s.output.outpoint,
				customInstructions: s.output.customInstructions,
			})),
		},
	);
	return { txid: result.txid, error: result.error };
}

export const canonicalPayKeyTransferActions: PayKeyTransferActions = {
	move: moveWalletOutputs,
	sendBsv21: sendBsv21.execute,
	sendAllBsv: sendAllBsv.execute,
};

export interface PayKeyTransferResult {
	address: string;
	txids: string[];
}

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size));
	}
	return out;
}

/**
 * Move every spendable output of the pay-key wallet on `ctx` to the identity
 * root's deposit address:
 * - ordinals (current, OpNS and older basket names): plain P2PKH, the same
 *   satoshis per output, input i to output i, 25 per transaction;
 * - BSV-21: `sendBsv21` per token for its whole balance (the overlay check
 *   stays on);
 * - BSV-20: a new transfer inscription for the same tick and amount, one
 *   output per transaction, so one bad output fails alone;
 * - plain BSV in the funding and deposit baskets is spent into wallet change
 *   (no outputs, as sweepDeposit does), then `sendAllBsv` sends all change,
 *   last, since every move above pays its fee from it.
 * Listed outputs, locks and outputs with no transfer here are not touched.
 * The wallet is read again afterwards; anything still there throws
 * PayKeyTransferIncompleteError, so the caller does not re-root.
 */
export async function transferPayKeyWallet(
	ctx: OneSatContext,
	identityWif: string,
	actions: PayKeyTransferActions = canonicalPayKeyTransferActions,
): Promise<PayKeyTransferResult> {
	const address = await identityDepositAddress(identityWif, ctx.chain);
	const destination = new P2PKH().lock(address);
	const txids: string[] = [];
	const errors: string[] = [];
	const failedReason = new Map<string, string>();

	const record = (
		label: string,
		sources: Holding[],
		result: { txid?: string; error?: string },
	) => {
		if (result.txid && !result.error) {
			txids.push(result.txid);
			return;
		}
		const reason = result.error
			? `${label} failed: ${result.error}`
			: `${label} returned no transaction id`;
		errors.push(reason);
		console.error(`[migration] ${reason}`, {
			outpoints: sources.map((s) => s.output.outpoint),
		});
		for (const s of sources) failedReason.set(s.output.outpoint, reason);
	};

	const move = async (label: string, sources: Holding[], scripts: string[]) => {
		try {
			record(
				label,
				sources,
				await actions.move(ctx.wallet, {
					description: label,
					sources,
					// No scripts: no outputs, so the whole value (less the fee)
					// comes back as wallet change for the send-all below.
					outputs: scripts.map((lockingScript, i) => ({
						lockingScript,
						satoshis: sources[i].output.satoshis,
					})),
				}),
			);
		} catch (error) {
			record(label, sources, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

	const holdings = await readHoldings(ctx.wallet);
	const ordinals: Holding[] = [];
	const bsv20: Holding[] = [];
	const plainBsv: Holding[] = [];
	const bsv21 = new Map<string, Holding[]>();
	let hasChange = false;

	for (const h of holdings) {
		if (isListed(h.output)) continue;
		if (h.kind === "bsv") {
			if (h.basket === CHANGE_BASKET) hasChange = true;
			else plainBsv.push(h);
		} else if (h.kind === "ordinal") {
			// A token output moved as a plain P2PKH would lose its tokens.
			if (isBsv21Ordinal(h.output)) continue;
			(isBsv20Ordinal(h.output) ? bsv20 : ordinals).push(h);
		} else if (h.kind === "bsv20") {
			bsv20.push(h);
		} else if (h.kind === "bsv21") {
			const tokenId = bsv21FieldsFromOutput(h.output).tokenId;
			if (!tokenId) continue;
			const list = bsv21.get(tokenId) ?? [];
			list.push(h);
			bsv21.set(tokenId, list);
		}
	}

	const p2pkh = destination.toHex();
	for (const group of chunk(ordinals, TRANSFER_CHUNK_SIZE)) {
		await move(
			`Move ${group.length} ordinal${group.length !== 1 ? "s" : ""} to identity wallet`,
			group,
			group.map(() => p2pkh),
		);
	}

	for (const h of bsv20) {
		const fields = bsv20Fields(h.output);
		if (!fields) continue;
		await move(
			`Move ${fields.amt} ${fields.tick} (BSV-20) to identity wallet`,
			[h],
			[BSV20.transfer(fields.tick, fields.amt).lock(destination).toHex()],
		);
	}

	for (const [tokenId, outputs] of bsv21) {
		let total = 0n;
		let known = true;
		for (const h of outputs) {
			const amt = atomicAmount(bsv21FieldsFromOutput(h.output).amt);
			if (amt === null) known = false;
			else total += amt;
		}
		if (!known || total <= 0n) continue;
		const label = `Move BSV-21 ${tokenId} to identity wallet`;
		try {
			record(
				label,
				outputs,
				await actions.sendBsv21(ctx, {
					tokenId,
					recipients: [{ amount: total, destination: { address } }],
				}),
			);
		} catch (error) {
			record(label, outputs, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	// Funding and deposit BSV is first gathered into wallet change (the way
	// sweepDeposit does), since only change funds a send; it pays its own fee.
	for (const group of chunk(plainBsv, TRANSFER_CHUNK_SIZE)) {
		await move(
			`Gather ${group.length} BSV output${group.length !== 1 ? "s" : ""} for the identity wallet`,
			group,
			[],
		);
	}

	// Last: every move above paid its fee from this change.
	if (hasChange || plainBsv.length > 0) {
		const label = "Move all BSV to identity wallet";
		try {
			const result = await actions.sendAllBsv(ctx, { destination: address });
			if (result.txid && !result.error) txids.push(result.txid);
			else {
				const reason = result.error
					? `${label} failed: ${result.error}`
					: `${label} returned no transaction id`;
				errors.push(reason);
				console.error(`[migration] ${reason}`);
			}
		} catch (error) {
			const reason = `${label} failed: ${error instanceof Error ? error.message : String(error)}`;
			errors.push(reason);
			console.error(`[migration] ${reason}`, error);
		}
	}

	const remaining = await readHoldings(ctx.wallet, false);
	if (remaining.length > 0) {
		const left = remaining.map((h) => ({
			basket: h.basket,
			outpoint: h.output.outpoint,
			reason: leftReason(h, failedReason, errors),
		}));
		console.error("[migration] pay-key wallet still holds outputs", left);
		throw new PayKeyTransferIncompleteError(left, txids, errors);
	}
	return { address, txids };
}

function leftReason(
	h: Holding,
	failedReason: Map<string, string>,
	errors: string[],
): string {
	const failed = failedReason.get(h.output.outpoint);
	if (failed) return failed;
	if (isListed(h.output)) return "still listed; cancel the listing first";
	switch (h.kind) {
		case "stuck":
			return h.basket === LOCK_BASKET || h.basket.endsWith(" lock")
				? "time-locked BSV; unlock it once the lock ends, then migrate"
				: "no transfer for this kind of output yet";
		case "bsv20":
			return "BSV-20 tick or amount unknown";
		case "ordinal":
			if (isBsv21Ordinal(h.output)) {
				return "BSV-21 output under an ordinals basket; it moves only from the bsv21 basket";
			}
			return isBsv20Ordinal(h.output)
				? "BSV-20 tick or amount unknown"
				: "still in the wallet after its transfer";
		case "bsv21": {
			const fields = bsv21FieldsFromOutput(h.output);
			if (!fields.tokenId) return "BSV-21 token id unknown";
			if (atomicAmount(fields.amt) === null) {
				return `BSV-21 amount unknown for a ${fields.tokenId} output`;
			}
			return "still in the wallet after its transfer";
		}
		case "bsv": {
			const bsvError = errors.find((e) => e.startsWith("Move all BSV"));
			return bsvError ?? "still in the wallet after the BSV transfer";
		}
	}
}
