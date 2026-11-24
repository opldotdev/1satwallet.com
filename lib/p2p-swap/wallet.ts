/**
 * Each wallet's part of a P2P swap: pick and check the assets, build or sign
 * the one transaction, send it, and take in what was received. Built on the
 * same SDK paths every 1Sat send uses: BRC-100 createAction with foreign
 * inputs, completeSignedAction, materializeSpends/buildSpendsForResolved and
 * internalizeBeef. Only P2PKH 1Sat outputs under the 1Sat protocol are
 * derived here, with swap-specific key IDs; no key scheme changes.
 */
import {
	buildSpendsForResolved,
	completeSignedAction,
	internalizeBeef,
	materializeSpends,
	type OneSatContext,
} from "@1sat/actions";
import { BSV21_BASKET, ONESAT_BASKET, ONESAT_PROTOCOL } from "@1sat/types";
import {
	Beef,
	type CreateActionResult,
	Hash,
	LockingScript,
	P2PKH,
	PublicKey,
	Spend,
	Transaction,
	UnlockingScript,
	Utils,
	type WalletOutput,
	type WalletProtocol,
} from "@bsv/sdk";
import { reportFailure } from "../runtime-diagnostics";
import type { P2PTradeItem } from "../types/p2p";
import { selectVerifiedBsv21Tips } from "../wallet/bsv21-offer-validation";
import {
	checkSwapCandidate,
	composeSwap,
	fromWalletOutpoint,
	type OverlayFee,
	type SwapItems,
	type SwapReceiveScripts,
	type SwapSource,
	type SwapTokenTip,
	swapOrdinalOrder,
	toWalletOutpoint,
} from "./candidate";
import type {
	SwapContribution,
	SwapOutcome,
	SwapSide,
	SwapSignature,
} from "./wire";

/** Logs a swap failure with its detail; never keys, scripts or outpoints. */
export function reportSwapFailure(
	operation: string,
	error: unknown,
	status?: string,
) {
	reportFailure(
		{
			category: "action",
			code: "action.failed",
			operation: `p2p-swap.${operation}`,
			recoverable: true,
			context: {
				status: status ?? (error instanceof SwapError ? error.code : undefined),
			},
		},
		error,
	);
}

/** A failure with a short message for people and a code for the logs. */
export class SwapError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "SwapError";
	}
}

const BRC29_PROTOCOL: WalletProtocol = [2, "3241645161d8"];
const P2PKH_UNLOCK_LENGTH = 108;
const SIGHASH_ALL_FORKID = 0x41;

export interface SwapSession extends SwapItems {
	sessionId: string;
	initiatorAllowsGift?: boolean;
	participantAllowsGift?: boolean;
	initiatorIdentity: string;
	participantIdentity: string;
	initiatorRevision: number;
	participantRevision: number;
}

export interface SwapSettlementView {
	builder: SwapSide;
	contribution: SwapContribution;
	candidate?: { txHex: string; hash: string };
	signatures?: { candidateHash: string; entries: SwapSignature[] };
	outcome?: SwapOutcome;
}

function other(side: SwapSide): SwapSide {
	return side === "initiator" ? "participant" : "initiator";
}

function itemsOf(session: SwapItems, side: SwapSide): readonly P2PTradeItem[] {
	return side === "initiator"
		? session.initiatorItems
		: session.participantItems;
}

function identityOf(session: SwapSession, side: SwapSide): string {
	return side === "initiator"
		? session.initiatorIdentity
		: session.participantIdentity;
}

function services(ctx: OneSatContext) {
	if (!ctx.services) {
		throw new SwapError(
			"services-missing",
			"The wallet can't reach the 1Sat network right now. Try again.",
		);
	}
	return ctx.services;
}

export function candidateHash(txHex: string): string {
	return Utils.toHex(Hash.sha256(txHex, "hex"));
}

function swapKeyID(sessionId: string, kind: string, id: string): string {
	return `p2pswap ${sessionId} ${kind} ${id}`;
}

function paymentDerivation(sessionId: string) {
	return {
		derivationPrefix: Utils.toBase64(Utils.toArray(sessionId, "utf8")),
		derivationSuffix: Utils.toBase64(Utils.toArray("swap", "utf8")),
	};
}

async function oneSatScript(
	ctx: OneSatContext,
	keyID: string,
): Promise<string> {
	const { publicKey } = await ctx.wallet.getPublicKey({
		protocolID: ONESAT_PROTOCOL,
		keyID,
		counterparty: "self",
		forSelf: true,
	});
	return new P2PKH()
		.lock(PublicKey.fromString(publicKey).toAddress(ctx.chain))
		.toHex();
}

interface SwapKeys {
	receive: SwapReceiveScripts;
	/** Receipt script → the key ID it was derived with. */
	keyIDs: Map<string, string>;
}

/**
 * The scripts where this side receives the peer's items and its own token
 * change. Derived from the session alone, so a reload derives the same ones.
 */
export async function deriveSwapKeys(
	ctx: OneSatContext,
	session: SwapSession,
	me: SwapSide,
): Promise<SwapKeys> {
	const keyIDs = new Map<string, string>();
	const derive = async (kind: string, id: string) => {
		const keyID = swapKeyID(session.sessionId, kind, id);
		const script = await oneSatScript(ctx, keyID);
		keyIDs.set(script, keyID);
		return [id, script] as const;
	};
	const peer = itemsOf(session, other(me));
	const mine = itemsOf(session, me);
	const nft = new Map(
		await Promise.all(
			peer.filter((i) => i.type === "ordinal").map((i) => derive("nft", i.id)),
		),
	);
	const token = new Map(
		await Promise.all(
			peer.filter((i) => i.type === "bsv21").map((i) => derive("token", i.id)),
		),
	);
	const change = new Map(
		await Promise.all(
			mine.filter((i) => i.type === "bsv21").map((i) => derive("change", i.id)),
		),
	);
	let satoshis: string | null = null;
	if (peer.some((i) => i.type === "satoshis")) {
		const { derivationPrefix, derivationSuffix } = paymentDerivation(
			session.sessionId,
		);
		const { publicKey } = await ctx.wallet.getPublicKey({
			protocolID: BRC29_PROTOCOL,
			keyID: `${derivationPrefix} ${derivationSuffix}`,
			counterparty: identityOf(session, other(me)),
			forSelf: true,
		});
		satoshis = new P2PKH()
			.lock(PublicKey.fromString(publicKey).toAddress(ctx.chain))
			.toHex();
	}
	return { receive: { nft, token, change, satoshis }, keyIDs };
}

async function listBasket(ctx: OneSatContext, basket: string) {
	const result = await ctx.wallet.listOutputs({
		basket,
		includeTags: true,
		includeCustomInstructions: true,
		limit: 10000,
	});
	return result.outputs;
}

/** My wallet's records for outpoints I will sign, with their key details. */
async function myOutputs(
	ctx: OneSatContext,
	outpoints: readonly string[],
): Promise<Map<string, WalletOutput>> {
	const wanted = new Set(outpoints);
	const found = new Map<string, WalletOutput>();
	for (const basket of [ONESAT_BASKET, BSV21_BASKET]) {
		for (const output of await listBasket(ctx, basket)) {
			const outpoint = fromWalletOutpoint(output.outpoint);
			if (wanted.has(outpoint) && output.spendable !== false) {
				found.set(outpoint, output);
			}
		}
	}
	return found;
}

/**
 * Token tips from my wallet that the overlay reports valid and unspent,
 * enough to cover what I offered of each token.
 */
export async function selectTokenTips(
	ctx: OneSatContext,
	items: readonly P2PTradeItem[],
): Promise<SwapTokenTip[]> {
	const result = await selectVerifiedBsv21Tips(ctx, items);
	if (!result.ok) throw new SwapError(`tips:${result.code}`, result.message);
	return result.tips;
}

async function requireOrdinals(
	ctx: OneSatContext,
	items: readonly P2PTradeItem[],
) {
	const ids = items.filter((i) => i.type === "ordinal").map((i) => i.id);
	if (ids.length === 0) return;
	const owned = await myOutputs(ctx, ids);
	const missing = items.find((i) => i.type === "ordinal" && !owned.has(i.id));
	if (missing) {
		throw new SwapError(
			"ordinal-missing",
			`${missing.name} is no longer in this wallet.`,
		);
	}
}

/** The non-builder's half: what it will sign and where it receives. */
export async function prepareContribution(
	ctx: OneSatContext,
	session: SwapSession,
	me: SwapSide,
): Promise<SwapContribution> {
	const mine = itemsOf(session, me);
	await requireOrdinals(ctx, mine);
	const tips = await selectTokenTips(ctx, mine);
	const { receive } = await deriveSwapKeys(ctx, session, me);
	const list = (map: ReadonlyMap<string, string>) =>
		[...map].map(([id, script]) => ({ id, script }));
	return {
		initiatorRevision: session.initiatorRevision,
		participantRevision: session.participantRevision,
		inputs: [
			...mine.filter((i) => i.type === "ordinal").map((i) => i.id),
			...tips.map((tip) => tip.outpoint),
		],
		receive: {
			nft: list(receive.nft),
			token: list(receive.token),
			change: list(receive.change),
			satoshis: receive.satoshis,
		},
	};
}

/** Raw source transactions for every input, each checked against its txid. */
async function loadSources(ctx: OneSatContext, tx: Transaction): Promise<void> {
	const beef = services(ctx).beef;
	const cache = new Map<string, Transaction>();
	for (const input of tx.inputs) {
		if (input.sourceTransaction) continue;
		const txid = input.sourceTXID;
		if (!txid) throw new SwapError("input-txid", "The swap is malformed.");
		let source = cache.get(txid);
		if (!source) {
			source = Transaction.fromBinary(Array.from(await beef.getRawTx(txid)));
			if (source.id("hex") !== txid) {
				throw new SwapError(
					"source-mismatch",
					"The 1Sat network returned the wrong transaction. Try again.",
				);
			}
			cache.set(txid, source);
		}
		input.sourceTransaction = source;
	}
}

function sourceOf(tx: Transaction) {
	return (vin: number): SwapSource | undefined => {
		const input = tx.inputs[vin];
		const output = input?.sourceTransaction?.outputs[input.sourceOutputIndex];
		if (!output || output.satoshis === undefined) return undefined;
		return {
			satoshis: output.satoshis,
			lockingScript: output.lockingScript.toHex(),
		};
	};
}

function outpointsOf(tx: Transaction): string[] {
	return tx.inputs.map(
		(input) =>
			`${input.sourceTXID ?? input.sourceTransaction?.id("hex")}_${input.sourceOutputIndex}`,
	);
}

/**
 * Checks the peer's side of the candidate against the network: its ordinals
 * are unspent and its token inputs are valid, unspent tips of their token.
 */
async function checkPeerAssets(
	ctx: OneSatContext,
	tx: Transaction,
	myInputs: ReadonlySet<string>,
	ordinalCount: number,
): Promise<void> {
	const svc = services(ctx);
	const outpoints = outpointsOf(tx);
	const peerOrdinals = outpoints
		.slice(0, ordinalCount)
		.filter((outpoint) => !myInputs.has(outpoint));
	if (peerOrdinals.length > 0) {
		const spends = await svc.txo.getSpends(peerOrdinals.map(toWalletOutpoint));
		if (spends.some((spend) => spend)) {
			throw new SwapError(
				"peer-ordinal-spent",
				"One of their ordinals has already moved. Ask them to update the offer.",
			);
		}
	}
	const peerTokens = new Map<string, string[]>();
	for (let vin = ordinalCount; vin < tx.inputs.length; vin++) {
		const outpoint = outpoints[vin];
		if (myInputs.has(outpoint)) continue;
		const source = sourceOf(tx)(vin);
		if (!source) continue;
		const { BSV21 } = await import("@1sat/templates");
		const token = BSV21.decode(LockingScript.fromHex(source.lockingScript));
		if (!token) continue;
		const tokenId =
			token.tokenData.op === "deploy+mint" ? outpoint : token.tokenData.id;
		if (!tokenId) {
			throw new SwapError(
				"peer-token-id",
				"Their tokens couldn't be verified.",
			);
		}
		const list = peerTokens.get(tokenId) ?? [];
		list.push(outpoint);
		peerTokens.set(tokenId, list);
	}
	for (const [tokenId, list] of peerTokens) {
		const rows = await svc.bsv21.validateOutputs(tokenId, list, {
			unspent: true,
			tags: "bsv21",
		});
		const valid = new Set(
			rows
				.filter((row) => !row.spend)
				.map((row) => fromWalletOutpoint(row.outpoint)),
		);
		if (list.some((outpoint) => !valid.has(outpoint))) {
			throw new SwapError(
				"peer-token-invalid",
				"Their tokens aren't valid on the 1Sat overlay right now.",
			);
		}
	}
}

interface StoredBuild {
	reference: string;
	signableTx: number[];
	inputBEEF: number[];
	/** The builder's own offered outpoints (txid_vout) it must sign. */
	myInputs: string[];
}

function buildKey(sessionId: string) {
	return `1sat-p2p-swap-build:${sessionId}`;
}

function storeBuild(sessionId: string, build: StoredBuild | null) {
	try {
		if (build)
			sessionStorage.setItem(buildKey(sessionId), JSON.stringify(build));
		else sessionStorage.removeItem(buildKey(sessionId));
	} catch (error) {
		reportSwapFailure("store-build", error);
	}
}

function sentKey(sessionId: string) {
	return `1sat-p2p-swap-sent:${sessionId}`;
}

/** The txid of a swap this tab broadcast, until its outcome is posted. */
function storeSent(sessionId: string, txid: string | null) {
	try {
		if (txid) sessionStorage.setItem(sentKey(sessionId), txid);
		else sessionStorage.removeItem(sentKey(sessionId));
	} catch (error) {
		reportSwapFailure("store-sent", error);
	}
}

export function readSentSwap(sessionId: string): string | null {
	try {
		const txid = sessionStorage.getItem(sentKey(sessionId));
		return txid && /^[0-9a-f]{64}$/.test(txid) ? txid : null;
	} catch (error) {
		reportSwapFailure("read-sent", error);
		return null;
	}
}

export function clearSentSwap(sessionId: string) {
	storeSent(sessionId, null);
}

export function readStoredBuild(sessionId: string): StoredBuild | null {
	try {
		const raw = sessionStorage.getItem(buildKey(sessionId));
		return raw ? (JSON.parse(raw) as StoredBuild) : null;
	} catch (error) {
		reportSwapFailure("read-build", error);
		return null;
	}
}

function myInputsAsBuilder(
	session: SwapSession,
	builder: SwapSide,
	tips: readonly SwapTokenTip[],
) {
	return [
		...itemsOf(session, builder)
			.filter((i) => i.type === "ordinal")
			.map((i) => i.id),
		...tips.map((tip) => tip.outpoint),
	];
}

async function tokenTipsFromSources(
	ctx: OneSatContext,
	outpoints: readonly string[],
): Promise<SwapTokenTip[]> {
	const { BSV21 } = await import("@1sat/templates");
	const tips: SwapTokenTip[] = [];
	for (const outpoint of outpoints) {
		const [txid, vout] = outpoint.split("_");
		const source = Transaction.fromBinary(
			Array.from(await services(ctx).beef.getRawTx(txid)),
		);
		if (source.id("hex") !== txid) {
			throw new SwapError(
				"source-mismatch",
				"The 1Sat network returned the wrong transaction.",
			);
		}
		const output = source.outputs[Number(vout)];
		const token = output ? BSV21.decode(output.lockingScript) : null;
		if (!token) {
			throw new SwapError(
				"peer-token-input",
				"Their token inputs couldn't be read.",
			);
		}
		const tokenId =
			token.tokenData.op === "deploy+mint" ? outpoint : token.tokenData.id;
		if (!tokenId) {
			throw new SwapError(
				"peer-token-input",
				"Their token inputs couldn't be read.",
			);
		}
		tips.push({ outpoint, tokenId, amount: token.getAmount() });
	}
	return tips;
}

/** Each traded token's overlay fee, read fresh from the overlay. */
async function readOverlayFees(
	ctx: OneSatContext,
	session: SwapSession,
): Promise<OverlayFee[]> {
	const svc = services(ctx);
	const tokenIds = new Set(
		[...session.initiatorItems, ...session.participantItems]
			.filter((i) => i.type === "bsv21")
			.map((i) => i.id),
	);
	const fees: OverlayFee[] = [];
	for (const tokenId of tokenIds) {
		const details = await svc.bsv21.getTokenDetails(tokenId, { fresh: true });
		if (!details.status.is_active) {
			throw new SwapError(
				"token-inactive",
				"A token in this trade isn't active on the 1Sat overlay.",
			);
		}
		fees.push({
			tokenId,
			address: details.status.fee_address,
			satoshisPerOutput: details.status.fee_per_output,
		});
	}
	return fees;
}

const feeScript = (address: string) => new P2PKH().lock(address).toHex();

function feeChecks(fees: readonly OverlayFee[]) {
	return fees.map((fee) => ({
		tokenId: fee.tokenId,
		script: feeScript(fee.address),
		satoshisPerOutput: fee.satoshisPerOutput,
	}));
}

/**
 * The builder: compose the transaction, have its wallet fund it without
 * signing, check the exact result from its own side, and keep the action
 * reference in this tab. Returns the unsigned transaction for the peer.
 */
export interface BuiltSwap {
	txHex: string;
	/** Satoshis this wallet spends on top of what it offered. */
	miningFee: number;
	overlayFee: number;
}

export async function buildSwapCandidate(
	ctx: OneSatContext,
	session: SwapSession,
	settlement: SwapSettlementView,
): Promise<BuiltSwap> {
	const builder = settlement.builder;
	const contributor = other(builder);
	const mine = itemsOf(session, builder);
	await requireOrdinals(ctx, mine);
	const builderTips = await selectTokenTips(ctx, mine);
	const contributorOrdinals = new Set(
		itemsOf(session, contributor)
			.filter((i) => i.type === "ordinal")
			.map((i) => i.id),
	);
	const contributorTips = await tokenTipsFromSources(
		ctx,
		settlement.contribution.inputs.filter((o) => !contributorOrdinals.has(o)),
	);
	const svc = services(ctx);
	const overlayFees = await readOverlayFees(ctx, session);
	const keys = await deriveSwapKeys(ctx, session, builder);
	const { inputs, outputs } = composeSwap({
		terms: session,
		builder,
		contribution: settlement.contribution,
		builderReceive: keys.receive,
		builderTips,
		contributorTips,
		overlayFees,
		feeLockingScript: feeScript,
	});

	const inputBeef = new Beef();
	for (const txid of new Set(inputs.map((o) => o.split("_")[0]))) {
		inputBeef.mergeBeef(await svc.getBeefForTxid(txid));
	}
	const inputBEEF = inputBeef.toBinary();
	const created = await ctx.wallet.createAction({
		description: "P2P swap",
		labels: ["p2p swap"],
		inputBEEF,
		inputs: inputs.map((outpoint) => ({
			outpoint: toWalletOutpoint(outpoint),
			inputDescription: "Swap asset",
			unlockingScriptLength: P2PKH_UNLOCK_LENGTH,
		})),
		outputs,
		options: { signAndProcess: false, randomizeOutputs: false },
	});
	const signable = created.signableTransaction;
	if (!signable?.tx || !signable.reference) {
		throw new SwapError(
			"no-signable",
			"The wallet couldn't prepare the swap. Check your balance and try again.",
		);
	}
	const reference = signable.reference;
	try {
		const beef = Beef.fromBinary(inputBEEF);
		beef.mergeBeef(Beef.fromBinary(signable.tx));
		const signing = Transaction.fromBEEF(signable.tx);
		const tx = beef.findAtomicTransaction(signing.id("hex"));
		if (!tx)
			throw new SwapError("no-tx", "The wallet couldn't prepare the swap.");
		await loadSources(ctx, tx);
		const check = checkSwapCandidate({
			tx,
			source: sourceOf(tx),
			terms: session,
			me: builder,
			myInputs: myInputsAsBuilder(session, builder, builderTips),
			myReceive: keys.receive,
			overlayFees: feeChecks(overlayFees),
		});
		if (!check.ok) {
			throw new SwapError(
				`builder-check:${check.reason}`,
				"The wallet built a swap that doesn't match the offers, so it was stopped.",
			);
		}
		// Their ordinals must be unspent and their tokens valid on the overlay,
		// or this side would pay for nothing.
		await checkPeerAssets(
			ctx,
			tx,
			new Set(myInputsAsBuilder(session, builder, builderTips)),
			swapOrdinalOrder(session).length,
		);
		storeBuild(session.sessionId, {
			reference,
			signableTx: Array.from(signable.tx),
			inputBEEF,
			myInputs: myInputsAsBuilder(session, builder, builderTips),
		});
		const unsigned = new Transaction(
			tx.version,
			tx.inputs.map((input) => ({
				sourceTXID: input.sourceTXID ?? input.sourceTransaction?.id("hex"),
				sourceOutputIndex: input.sourceOutputIndex,
				sequence: input.sequence ?? 0xffffffff,
				unlockingScript: new UnlockingScript(),
			})),
			tx.outputs.map((output) => ({
				satoshis: output.satoshis,
				lockingScript: output.lockingScript,
			})),
			tx.lockTime,
		);
		const inSats = tx.inputs.reduce(
			(sum, input) =>
				sum +
				(input.sourceTransaction?.outputs[input.sourceOutputIndex]?.satoshis ??
					0),
			0,
		);
		const outSats = tx.outputs.reduce(
			(sum, output) => sum + (output.satoshis ?? 0),
			0,
		);
		const overlayFee = outputs
			.filter((output) => output.outputDescription === "Token overlay fee")
			.reduce((sum, output) => sum + output.satoshis, 0);
		return { txHex: unsigned.toHex(), miningFee: inSats - outSats, overlayFee };
	} catch (error) {
		await ctx.wallet.abortAction({ reference }).catch((abortError) => {
			reportSwapFailure("abort-build", abortError);
		});
		throw error;
	}
}

export interface SwapReview {
	txHex: string;
	hash: string;
	/** Mining fee and overlay fees, paid by the builder. */
	builderPaysSatoshis: number;
}

/**
 * The non-builder: rebuild the exact candidate from the network, check it
 * from its own side and the peer's assets, then sign only its own inputs.
 */
export async function signSwapCandidate(
	ctx: OneSatContext,
	session: SwapSession,
	settlement: SwapSettlementView,
	me: SwapSide,
): Promise<{ hash: string; signatures: SwapSignature[] }> {
	const candidate = settlement.candidate;
	if (!candidate) throw new SwapError("no-candidate", "No swap to sign yet.");
	if (candidateHash(candidate.txHex) !== candidate.hash) {
		throw new SwapError(
			"hash-mismatch",
			"The swap changed in transit. Try again.",
		);
	}
	const tx = Transaction.fromHex(candidate.txHex);
	await loadSources(ctx, tx);
	const keys = await deriveSwapKeys(ctx, session, me);
	const myInputs = settlement.contribution.inputs;
	const check = checkSwapCandidate({
		tx,
		source: sourceOf(tx),
		terms: session,
		me,
		myInputs,
		myReceive: keys.receive,
		overlayFees: feeChecks(await readOverlayFees(ctx, session)),
	});
	if (!check.ok) {
		throw new SwapError(
			`peer-check:${check.reason}`,
			"Their swap doesn't match the locked offers, so this wallet won't sign it.",
		);
	}
	await checkPeerAssets(
		ctx,
		tx,
		new Set(myInputs),
		swapOrdinalOrder(session).length,
	);
	const owned = await myOutputs(ctx, myInputs);
	const resolved = await materializeSpends(
		ctx.wallet,
		myInputs.map((outpoint) => {
			const output = owned.get(outpoint);
			if (!output?.customInstructions) {
				throw new SwapError(
					"my-output-missing",
					"Something you offered is no longer in this wallet.",
				);
			}
			return {
				outpoint: toWalletOutpoint(outpoint),
				customInstructions: output.customInstructions,
			};
		}),
	);
	if ("error" in resolved) {
		throw new SwapError(
			`resolve:${resolved.error}`,
			"This wallet couldn't sign the swap.",
		);
	}
	const spends = await buildSpendsForResolved(ctx.wallet, tx, resolved);
	if ("error" in spends) {
		throw new SwapError(
			`sign:${spends.error}`,
			"This wallet couldn't sign the swap.",
		);
	}
	const signatures: SwapSignature[] = [];
	for (const vin of check.myInputIndexes) {
		const spend = spends[vin];
		if (!spend)
			throw new SwapError(
				"unsigned-input",
				"This wallet couldn't sign the swap.",
			);
		verifySpend(tx, vin, spend.unlockingScript);
		signatures.push({ vin, unlockingScript: spend.unlockingScript });
	}
	return { hash: candidate.hash, signatures };
}

function verifySpend(tx: Transaction, vin: number, unlockingHex: string) {
	const input = tx.inputs[vin];
	const source = input.sourceTransaction?.outputs[input.sourceOutputIndex];
	if (!source)
		throw new SwapError("verify-source", "The swap couldn't be checked.");
	let valid = false;
	try {
		valid = new Spend({
			sourceTXID: input.sourceTXID ?? input.sourceTransaction?.id("hex") ?? "",
			sourceOutputIndex: input.sourceOutputIndex,
			lockingScript: source.lockingScript,
			sourceSatoshis: source.satoshis ?? 0,
			transactionVersion: tx.version,
			otherInputs: tx.inputs.filter((_, j) => j !== vin),
			unlockingScript: UnlockingScript.fromHex(unlockingHex),
			inputSequence: input.sequence ?? 0xffffffff,
			inputIndex: vin,
			outputs: tx.outputs,
			lockTime: tx.lockTime,
		}).validate();
	} catch (error) {
		reportSwapFailure(`verify-${vin}`, error);
	}
	if (!valid)
		throw new SwapError(`verify-${vin}`, "A swap signature didn't verify.");
}

function sighashByte(unlockingHex: string): number | undefined {
	const chunk = UnlockingScript.fromHex(unlockingHex).chunks[0]?.data;
	return chunk?.[chunk.length - 1];
}

/** Errors completeSignedAction returns before signAction runs. */
const PRE_SIGN_ERRORS = [
	"no-signable-transaction",
	"failed-to-build-verification-beef",
	"missing-source-transaction-for-input-",
	"script-verification-failed-for-input-",
];

export type FinishResult =
	| { kind: "txid"; txid: string; beef?: number[] }
	| { kind: "failed"; code: string; message: string }
	| { kind: "unknown"; code: string };

/**
 * The builder: add the peer's signatures and its own, have the wallet sign
 * its funding inputs and broadcast. A failure before the wallet signs means
 * nothing moved; a failure after it may still have reached the network, so
 * it is reported as unknown and reconciled from the chain.
 */
export async function finishSwap(
	ctx: OneSatContext,
	session: SwapSession,
	settlement: SwapSettlementView,
): Promise<FinishResult> {
	const stored = readStoredBuild(session.sessionId);
	if (!stored) {
		throw new SwapError(
			"no-build",
			"This swap was prepared in another tab or before a reload, so it can't finish here.",
		);
	}
	const candidate = settlement.candidate;
	const peerSignatures = settlement.signatures?.entries ?? [];
	if (
		!candidate ||
		(settlement.signatures &&
			settlement.signatures.candidateHash !== candidate.hash)
	) {
		throw new SwapError(
			"signature-mismatch",
			"Their signatures don't match this swap.",
		);
	}
	for (const signature of peerSignatures) {
		if (sighashByte(signature.unlockingScript) !== SIGHASH_ALL_FORKID) {
			throw new SwapError(
				"sighash",
				"Their signature doesn't cover the whole swap.",
			);
		}
	}
	const contributorInputs = new Set(settlement.contribution.inputs);
	const createResult: CreateActionResult = {
		signableTransaction: { reference: stored.reference, tx: stored.signableTx },
	};
	let signing = false;
	try {
		const result = await completeSignedAction(
			ctx.wallet,
			createResult,
			stored.inputBEEF,
			async (tx) => {
				if (unsignedHex(tx) !== candidate.txHex) {
					throw new SwapError(
						"candidate-drift",
						"The swap changed after it was built.",
					);
				}
				const outpoints = outpointsOf(tx);
				await loadSources(ctx, tx);
				await checkPeerAssets(
					ctx,
					tx,
					new Set(stored.myInputs),
					swapOrdinalOrder(session).length,
				);
				const owned = await myOutputs(ctx, stored.myInputs);
				const resolved = await materializeSpends(
					ctx.wallet,
					stored.myInputs.map((outpoint) => {
						const output = owned.get(outpoint);
						if (!output?.customInstructions) {
							throw new SwapError(
								"my-output-missing",
								"Something you offered is no longer in this wallet.",
							);
						}
						return {
							outpoint: toWalletOutpoint(outpoint),
							customInstructions: output.customInstructions,
						};
					}),
				);
				if ("error" in resolved) {
					throw new SwapError(
						`resolve:${resolved.error}`,
						"This wallet couldn't sign the swap.",
					);
				}
				const spends = await buildSpendsForResolved(ctx.wallet, tx, resolved);
				if ("error" in spends) {
					throw new SwapError(
						`sign:${spends.error}`,
						"This wallet couldn't sign the swap.",
					);
				}
				const peerVins = new Set<number>();
				for (const signature of peerSignatures) {
					if (!contributorInputs.has(outpoints[signature.vin] ?? "")) {
						throw new SwapError(
							"foreign-signature",
							"Their signatures don't match this swap.",
						);
					}
					verifySpend(tx, signature.vin, signature.unlockingScript);
					peerVins.add(signature.vin);
					spends[signature.vin] = {
						unlockingScript: signature.unlockingScript,
					};
				}
				outpoints.forEach((outpoint, vin) => {
					if (contributorInputs.has(outpoint) && !peerVins.has(vin)) {
						throw new SwapError(
							"peer-unsigned",
							"They haven't signed all of their side yet.",
						);
					}
				});
				signing = true;
				return spends;
			},
		);
		if (result.txid) {
			storeBuild(session.sessionId, null);
			storeSent(session.sessionId, result.txid);
			return { kind: "txid", txid: result.txid, beef: result.tx };
		}
		const code = result.error ?? "no-txid";
		// A transaction the network judged invalid can never land; a double
		// spend may still win its race, so that stays unknown until the chain
		// shows which spend won.
		if (
			PRE_SIGN_ERRORS.some((prefix) => code.startsWith(prefix)) ||
			/invalid/i.test(code)
		) {
			storeBuild(session.sessionId, null);
			return {
				kind: "failed",
				code,
				message: "A signature didn't verify, so nothing moved.",
			};
		}
		return { kind: "unknown", code };
	} catch (error) {
		if (!signing) {
			// completeSignedAction aborts the action before rethrowing.
			storeBuild(session.sessionId, null);
			if (error instanceof SwapError) {
				return { kind: "failed", code: error.code, message: error.message };
			}
			throw error;
		}
		return {
			kind: "unknown",
			code:
				error instanceof Error ? error.name || "sign-action" : "sign-action",
		};
	}
}

function unsignedHex(tx: Transaction): string {
	return new Transaction(
		tx.version,
		tx.inputs.map((input) => ({
			sourceTXID: input.sourceTXID ?? input.sourceTransaction?.id("hex"),
			sourceOutputIndex: input.sourceOutputIndex,
			sequence: input.sequence ?? 0xffffffff,
			unlockingScript: new UnlockingScript(),
		})),
		tx.outputs.map((output) => ({
			satoshis: output.satoshis,
			lockingScript: output.lockingScript,
		})),
		tx.lockTime,
	).toHex();
}

/** Abandon a built swap that will not be finished, releasing its funding. */
export async function abandonSwapBuild(ctx: OneSatContext, sessionId: string) {
	const stored = readStoredBuild(sessionId);
	if (!stored) return;
	try {
		await ctx.wallet.abortAction({ reference: stored.reference });
	} finally {
		storeBuild(sessionId, null);
	}
}

function sameShape(final: Transaction, candidateHex: string): boolean {
	return unsignedHex(final) === candidateHex;
}

/**
 * After the swap is broadcast: tell the token overlay, then add this side's
 * receipts to its wallet. The final transaction must be the reviewed one.
 */
export async function receiveSwap(
	ctx: OneSatContext,
	session: SwapSession,
	settlement: SwapSettlementView,
	me: SwapSide,
	txid: string,
	knownBeef?: number[],
): Promise<void> {
	const svc = services(ctx);
	const candidate = settlement.candidate;
	if (!candidate)
		throw new SwapError("no-candidate", "The swap record is incomplete.");
	const beef = knownBeef
		? Beef.fromBinary(knownBeef)
		: await svc.getBeefForTxid(txid);
	const final = beef.findTxid(txid)?.tx;
	if (
		!final ||
		final.id("hex") !== txid ||
		!sameShape(final, candidate.txHex)
	) {
		throw new SwapError(
			"final-mismatch",
			"The broadcast transaction isn't the swap you reviewed.",
		);
	}
	const beefBytes = beef.toBinary();
	const tokenIds = new Set(
		[...session.initiatorItems, ...session.participantItems]
			.filter((i) => i.type === "bsv21")
			.map((i) => i.id),
	);
	for (const tokenId of tokenIds) {
		try {
			await svc.overlay.submitBsv21(beefBytes, tokenId);
		} catch (error) {
			// The overlay also learns of the transaction from the network; a
			// failed submit only delays indexing.
			reportSwapFailure("overlay-submit", error);
		}
	}
	const keys = await deriveSwapKeys(ctx, session, me);
	const peerIdentity = identityOf(session, other(me));
	const outputs: { outputIndex: number; keyID: string }[] = [];
	final.outputs.forEach((output, outputIndex) => {
		const keyID = keys.keyIDs.get(output.lockingScript.toHex().slice(-50));
		const hex = output.lockingScript.toHex();
		if (keyID && (hex.length === 50 || output.satoshis === 1)) {
			outputs.push({ outputIndex, keyID });
		}
	});
	if (outputs.length > 0) {
		await internalizeBeef({
			beef: Uint8Array.from(beefBytes),
			wallet: ctx.wallet,
			services: svc,
			chain: ctx.chain,
			outputs: outputs.map((o) => ({
				...o,
				protocolID: ONESAT_PROTOCOL,
				counterparty: "self",
				senderIdentityKey: peerIdentity,
			})),
		});
	}
	const paymentScript = keys.receive.satoshis;
	if (paymentScript) {
		const outputIndex = final.outputs.findIndex(
			(output) => output.lockingScript.toHex() === paymentScript,
		);
		if (outputIndex < 0) {
			throw new SwapError(
				"payment-missing",
				"The BSV payment is missing from the swap.",
			);
		}
		const result = await ctx.wallet.internalizeAction({
			tx: beef.toBinaryAtomic(txid),
			outputs: [
				{
					outputIndex,
					protocol: "wallet payment",
					paymentRemittance: {
						...paymentDerivation(session.sessionId),
						senderIdentityKey: peerIdentity,
					},
				},
			],
			labels: ["p2p swap"],
			description: "P2P swap payment received",
		});
		if (result?.accepted !== true) {
			throw new SwapError(
				"payment-refused",
				"The wallet didn't accept the BSV payment.",
			);
		}
	}
}

/**
 * Where an unfinished swap stands on chain, after a reload or a lost
 * broadcast reply: the reviewed swap's txid once its first input is spent by
 * it, failed if that input was spent by something else, or null while it is
 * still unspent.
 */
export async function reconcileSwap(
	ctx: OneSatContext,
	candidateHex: string,
): Promise<{ kind: "txid"; txid: string } | { kind: "failed" } | null> {
	const svc = services(ctx);
	const inputs = Transaction.fromHex(candidateHex).inputs;
	if (inputs.length === 0 || inputs.some((input) => !input.sourceTXID)) {
		return null;
	}
	const spenders = await svc.txo.getSpends(
		inputs.map((input) => `${input.sourceTXID}.${input.sourceOutputIndex}`),
	);
	let movedElsewhere = false;
	for (const spender of new Set(spenders)) {
		if (!spender) continue;
		const beef = await svc.getBeefForTxid(spender);
		const tx = beef.findTxid(spender)?.tx;
		if (!tx) continue;
		if (sameShape(tx, candidateHex)) return { kind: "txid", txid: spender };
		movedElsewhere = true;
	}
	return movedElsewhere ? { kind: "failed" } : null;
}
