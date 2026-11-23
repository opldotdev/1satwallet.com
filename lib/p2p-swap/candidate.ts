/**
 * The swap transaction's shape, and the check each wallet runs on the exact
 * candidate before it signs. Pure: no wallet or network calls.
 *
 * Layout (docs/p2p-settlement-protocol.md):
 * - inputs: every offered ordinal (initiator's, then participant's), then the
 *   token tips (initiator's, then participant's), then the builder's funding;
 * - outputs: one 1-sat receipt per ordinal, index-aligned with its input, so
 *   each inscribed sat lands in its receipt; then token receipts, token
 *   change, one overlay fee output per token, the BSV payment, and the
 *   builder's change.
 */
import { BSV21 } from "@1sat/templates";
import { LockingScript, type Transaction } from "@bsv/sdk";
import type { P2PTradeItem } from "../types/p2p";
import { offeredSatoshis, type SwapContribution, type SwapSide } from "./wire";

export interface SwapItems {
	initiatorItems: readonly P2PTradeItem[];
	participantItems: readonly P2PTradeItem[];
}

/** A token tip with its amount, as the wallet that owns it read it. */
export interface SwapTokenTip {
	outpoint: string;
	tokenId: string;
	amount: bigint;
}

export interface SwapOutputSpec {
	lockingScript: string;
	satoshis: number;
	outputDescription: string;
}

export interface SwapReceiveScripts {
	nft: ReadonlyMap<string, string>;
	token: ReadonlyMap<string, string>;
	change: ReadonlyMap<string, string>;
	satoshis: string | null;
}

export interface OverlayFee {
	tokenId: string;
	address: string;
	satoshisPerOutput: number;
}

const P2PKH_SCRIPT = /^76a914[0-9a-f]{40}88ac$/;

function other(side: SwapSide): SwapSide {
	return side === "initiator" ? "participant" : "initiator";
}

function itemsOf(terms: SwapItems, side: SwapSide) {
	return side === "initiator" ? terms.initiatorItems : terms.participantItems;
}

function ordinalIds(items: readonly P2PTradeItem[]): string[] {
	return items.filter((item) => item.type === "ordinal").map((item) => item.id);
}

function tokenItems(items: readonly P2PTradeItem[]) {
	return items.filter(
		(item): item is Extract<P2PTradeItem, { type: "bsv21" }> =>
			item.type === "bsv21",
	);
}

/** Ordinals in input order: the initiator's, then the participant's. */
export function swapOrdinalOrder(terms: SwapItems): string[] {
	return [
		...ordinalIds(terms.initiatorItems),
		...ordinalIds(terms.participantItems),
	];
}

export function toWalletOutpoint(outpoint: string): string {
	return outpoint.replace("_", ".");
}

export function fromWalletOutpoint(outpoint: string): string {
	return outpoint.replace(".", "_");
}

export function receiveScriptsFromContribution(
	contribution: SwapContribution,
): SwapReceiveScripts {
	const map = (entries: { id: string; script: string }[]) =>
		new Map(entries.map((entry) => [entry.id, entry.script]));
	return {
		nft: map(contribution.receive.nft),
		token: map(contribution.receive.token),
		change: map(contribution.receive.change),
		satoshis: contribution.receive.satoshis,
	};
}

function tokenScript(tokenId: string, amount: bigint, owner: string): string {
	return BSV21.transfer(tokenId, amount)
		.lock(LockingScript.fromHex(owner))
		.toHex();
}

function sumByToken(tips: readonly SwapTokenTip[]) {
	const totals = new Map<string, bigint>();
	for (const tip of tips) {
		totals.set(tip.tokenId, (totals.get(tip.tokenId) ?? 0n) + tip.amount);
	}
	return totals;
}

/**
 * The builder's inputs and outputs for createAction. Funding inputs and the
 * builder's change are added by its wallet after these.
 */
export function composeSwap(args: {
	terms: SwapItems;
	builder: SwapSide;
	contribution: SwapContribution;
	builderReceive: SwapReceiveScripts;
	builderTips: readonly SwapTokenTip[];
	contributorTips: readonly SwapTokenTip[];
	overlayFees: readonly OverlayFee[];
	feeLockingScript: (address: string) => string;
}): { inputs: string[]; outputs: SwapOutputSpec[] } {
	const { terms, builder } = args;
	const contributor = other(builder);
	const contributorReceive = receiveScriptsFromContribution(args.contribution);
	const receiveFor = (side: SwapSide) =>
		side === builder ? args.builderReceive : contributorReceive;
	const tipsOf = (side: SwapSide) =>
		side === builder ? args.builderTips : args.contributorTips;

	const inputs: string[] = [];
	const outputs: SwapOutputSpec[] = [];
	for (const side of ["initiator", "participant"] as const) {
		const recipient = receiveFor(other(side));
		for (const id of ordinalIds(itemsOf(terms, side))) {
			const script = recipient.nft.get(id);
			if (!script) throw new Error(`No receive script for ordinal ${id}`);
			inputs.push(id);
			outputs.push({
				lockingScript: script,
				satoshis: 1,
				outputDescription: "Swap ordinal",
			});
		}
	}
	for (const side of ["initiator", "participant"] as const) {
		for (const tip of tipsOf(side)) inputs.push(tip.outpoint);
	}

	const tokenOutputs = new Map<string, number>();
	const countToken = (tokenId: string) =>
		tokenOutputs.set(tokenId, (tokenOutputs.get(tokenId) ?? 0) + 1);
	for (const side of ["initiator", "participant"] as const) {
		const recipient = receiveFor(other(side));
		for (const item of tokenItems(itemsOf(terms, side))) {
			const script = recipient.token.get(item.id);
			if (!script) throw new Error(`No receive script for token ${item.id}`);
			outputs.push({
				lockingScript: tokenScript(item.id, BigInt(item.amount), script),
				satoshis: 1,
				outputDescription: "Swap tokens",
			});
			countToken(item.id);
		}
	}
	for (const side of ["initiator", "participant"] as const) {
		const totals = sumByToken(tipsOf(side));
		const owner = receiveFor(side);
		for (const item of tokenItems(itemsOf(terms, side))) {
			const change = (totals.get(item.id) ?? 0n) - BigInt(item.amount);
			if (change < 0n) throw new Error(`Not enough ${item.name} to swap`);
			if (change === 0n) continue;
			const script = owner.change.get(item.id);
			if (!script) throw new Error(`No change script for token ${item.id}`);
			outputs.push({
				lockingScript: tokenScript(item.id, change, script),
				satoshis: 1,
				outputDescription: "Swap token change",
			});
			countToken(item.id);
		}
	}
	for (const fee of args.overlayFees) {
		const count = tokenOutputs.get(fee.tokenId) ?? 0;
		if (count === 0 || fee.satoshisPerOutput <= 0) continue;
		outputs.push({
			lockingScript: args.feeLockingScript(fee.address),
			satoshis: fee.satoshisPerOutput * count,
			outputDescription: "Token overlay fee",
		});
	}
	const payment = offeredSatoshis(itemsOf(terms, builder));
	if (payment > 0) {
		const script = receiveFor(contributor).satoshis;
		if (!script) throw new Error("No receive script for BSV");
		outputs.push({
			lockingScript: script,
			satoshis: payment,
			outputDescription: "Swap payment",
		});
	}
	return { inputs, outputs };
}

export interface SwapSource {
	satoshis: number;
	lockingScript: string;
}

export type SwapCheck =
	| { ok: true; myInputIndexes: number[] }
	| { ok: false; reason: string };

interface TokenRead {
	tokenId: string;
	amount: bigint;
	op: string;
}

function readToken(lockingScript: string, outpoint: string): TokenRead | null {
	const token = BSV21.decode(LockingScript.fromHex(lockingScript));
	if (!token) return null;
	const { op, id } = token.tokenData;
	const tokenId = op === "deploy+mint" || op === "deploy+auth" ? outpoint : id;
	if (!tokenId) return { tokenId: "", amount: 0n, op };
	let amount = 0n;
	try {
		amount = token.getAmount();
	} catch {
		amount = -1n;
	}
	return { tokenId, amount, op };
}

const SPENDABLE_TOKEN_OPS = new Set(["transfer", "deploy+mint", "mint"]);

/**
 * Checks the exact candidate from one side's view, failing closed. It proves:
 * the inputs this side signs appear once each; every ordinal moves to its
 * index-aligned 1-sat receipt; this side receives every token amount and the
 * BSV the peer offered, and its own token change; every token is conserved
 * per id with only transfer outputs; and every output is plain P2PKH or a
 * token transfer to P2PKH. `source(vin)` must cover every input.
 */
export function checkSwapCandidate(args: {
	tx: Transaction;
	source: (vin: number) => SwapSource | undefined;
	terms: SwapItems;
	me: SwapSide;
	myInputs: readonly string[];
	myReceive: SwapReceiveScripts;
	/** Every token's overlay fee, read fresh by this side. */
	overlayFees: readonly {
		tokenId: string;
		script: string;
		satoshisPerOutput: number;
	}[];
}): SwapCheck {
	const { tx, terms, me } = args;
	const fail = (reason: string): SwapCheck => ({ ok: false, reason });
	if (tx.version !== 1 || tx.lockTime !== 0) return fail("non-final-tx");

	const outpoints: string[] = [];
	for (const input of tx.inputs) {
		const txid = input.sourceTXID ?? input.sourceTransaction?.id("hex");
		if (!txid) return fail("input-without-txid");
		if ((input.sequence ?? 0xffffffff) !== 0xffffffff) {
			return fail("non-final-sequence");
		}
		outpoints.push(`${txid}_${input.sourceOutputIndex}`);
	}
	if (new Set(outpoints).size !== outpoints.length) {
		return fail("duplicate-input");
	}

	const sources: SwapSource[] = [];
	for (let vin = 0; vin < tx.inputs.length; vin++) {
		const source = args.source(vin);
		if (!source) return fail(`missing-source-${vin}`);
		sources.push(source);
	}

	const myItems = itemsOf(terms, me);
	const peerItems = itemsOf(terms, other(me));
	const mine = new Set(ordinalIds(myItems));
	const order = swapOrdinalOrder(terms);
	if (tx.inputs.length < order.length || tx.outputs.length < order.length) {
		return fail("too-few-inputs");
	}
	for (let i = 0; i < order.length; i++) {
		const id = order[i];
		if (outpoints[i] !== id) return fail(`ordinal-input-${i}`);
		if (sources[i].satoshis !== 1) return fail(`ordinal-not-one-sat-${i}`);
		if (readToken(sources[i].lockingScript, id)) {
			return fail(`ordinal-is-token-${i}`);
		}
		const output = tx.outputs[i];
		if (output?.satoshis !== 1) return fail(`ordinal-receipt-${i}`);
		if (!mine.has(id)) {
			const expected = args.myReceive.nft.get(id);
			if (!expected || output.lockingScript.toHex() !== expected) {
				return fail(`ordinal-receipt-script-${i}`);
			}
		}
	}

	const myInputIndexes: number[] = [];
	for (const outpoint of args.myInputs) {
		const at = outpoints.indexOf(outpoint);
		if (at < 0) return fail("my-input-missing");
		myInputIndexes.push(at);
	}
	for (const id of mine) {
		if (!args.myInputs.includes(id)) return fail("my-ordinal-not-signed");
	}
	// This side signs only what it offered: its ordinals in their slots and
	// tips of the tokens it offered, never anything else a relay slipped in.
	const myTokenIds = new Set(tokenItems(myItems).map((item) => item.id));
	for (const at of myInputIndexes) {
		if (at < order.length) {
			if (!mine.has(outpoints[at])) return fail(`my-input-not-offered-${at}`);
			continue;
		}
		const token = readToken(sources[at].lockingScript, outpoints[at]);
		if (!token || !myTokenIds.has(token.tokenId)) {
			return fail(`my-input-not-offered-${at}`);
		}
	}

	const tokenIn = new Map<string, bigint>();
	const myTokenIn = new Map<string, bigint>();
	const mySet = new Set(args.myInputs);
	for (let vin = 0; vin < sources.length; vin++) {
		const token = readToken(sources[vin].lockingScript, outpoints[vin]);
		if (!token) continue;
		if (!SPENDABLE_TOKEN_OPS.has(token.op) || !token.tokenId) {
			return fail(`token-input-op-${vin}`);
		}
		if (token.amount <= 0n) return fail(`token-input-amount-${vin}`);
		if (vin < order.length) return fail(`token-in-ordinal-slot-${vin}`);
		tokenIn.set(
			token.tokenId,
			(tokenIn.get(token.tokenId) ?? 0n) + token.amount,
		);
		if (mySet.has(outpoints[vin])) {
			myTokenIn.set(
				token.tokenId,
				(myTokenIn.get(token.tokenId) ?? 0n) + token.amount,
			);
		}
	}

	const tokenOut = new Map<string, bigint>();
	const tokenOutCount = new Map<string, number>();
	const outputHex: string[] = [];
	for (let vout = 0; vout < tx.outputs.length; vout++) {
		const hex = tx.outputs[vout].lockingScript.toHex();
		outputHex.push(hex);
		if (P2PKH_SCRIPT.test(hex)) continue;
		const token = readToken(hex, "");
		if (token?.op !== "transfer" || token.amount <= 0n) {
			return fail(`output-kind-${vout}`);
		}
		const owner = hex.slice(-50);
		if (
			!P2PKH_SCRIPT.test(owner) ||
			tokenScript(token.tokenId, token.amount, owner) !== hex
		) {
			return fail(`output-token-shape-${vout}`);
		}
		if (tx.outputs[vout].satoshis !== 1)
			return fail(`token-output-sats-${vout}`);
		tokenOut.set(
			token.tokenId,
			(tokenOut.get(token.tokenId) ?? 0n) + token.amount,
		);
		tokenOutCount.set(
			token.tokenId,
			(tokenOutCount.get(token.tokenId) ?? 0) + 1,
		);
	}
	for (const [tokenId, amount] of tokenOut) {
		if (tokenIn.get(tokenId) !== amount)
			return fail(`token-conservation-${tokenId}`);
	}
	for (const [tokenId, amount] of tokenIn) {
		if (tokenOut.get(tokenId) !== amount) return fail(`token-burn-${tokenId}`);
	}
	for (const tokenId of tokenOut.keys()) {
		const fee = args.overlayFees.find((f) => f.tokenId === tokenId);
		if (!fee) return fail(`overlay-fee-unknown-${tokenId}`);
		const due = fee.satoshisPerOutput * (tokenOutCount.get(tokenId) ?? 0);
		if (due <= 0) continue;
		const paid = tx.outputs.some(
			(output, vout) =>
				outputHex[vout] === fee.script && output.satoshis === due,
		);
		if (!paid) return fail(`overlay-fee-${tokenId}`);
	}

	for (const item of tokenItems(peerItems)) {
		const script = args.myReceive.token.get(item.id);
		if (
			!script ||
			!outputHex.includes(tokenScript(item.id, BigInt(item.amount), script))
		) {
			return fail(`my-token-receipt-${item.id}`);
		}
	}
	for (const item of tokenItems(myItems)) {
		const have = myTokenIn.get(item.id) ?? 0n;
		const change = have - BigInt(item.amount);
		if (change < 0n) return fail(`my-token-short-${item.id}`);
		if (change === 0n) continue;
		const script = args.myReceive.change.get(item.id);
		if (!script || !outputHex.includes(tokenScript(item.id, change, script))) {
			return fail(`my-token-change-${item.id}`);
		}
	}
	for (const tokenId of myTokenIn.keys()) {
		if (!tokenItems(myItems).some((item) => item.id === tokenId)) {
			return fail(`my-unoffered-token-${tokenId}`);
		}
	}

	const payment = offeredSatoshis(peerItems);
	if (payment > 0) {
		const script = args.myReceive.satoshis;
		const paid = tx.outputs.some(
			(output, vout) =>
				outputHex[vout] === script && output.satoshis === payment,
		);
		if (!script || !paid) return fail("my-payment");
	}

	return { ok: true, myInputIndexes };
}
