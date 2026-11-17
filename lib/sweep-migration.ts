"use client";

import {
	type Bsv20Balance,
	createContext,
	prepareSweepInputs,
	sweepBsv,
	sweepBsv20,
	sweepBsv21,
	sweepOrdinals,
	type TokenBalance,
} from "@1sat/actions";
import { type IndexedOutput, normalizeOutpoint } from "@1sat/types";
import type { OneSatServices } from "@1sat/wallet-browser";
import { PrivateKey, type WalletInterface } from "@bsv/sdk";
import {
	BSV20_UNCONFIRMED_REASON,
	excludeUnsweepableTokens,
	hasIndexedBsv20Amount,
	isListedOutput,
	isolateListedBatches,
} from "@/lib/wallet/migration-listings";

// Chunk sizes: each chunk is its own transaction, so one bad output or a
// single oversized tx can't sink an entire large sweep, and each completed
// chunk is real on-chain progress the user can see.
const FUNDING_CHUNK_SIZE = 200;
const ORDINAL_CHUNK_SIZE = 50;
const TOKEN_CHUNK_SIZE = 50;
/** Concurrent BEEF fetches during input preparation */
const PREPARE_CONCURRENCY = 6;

export interface SweepStepState {
	id: string;
	label: string;
	status: "pending" | "active" | "done" | "error";
	/** Live sub-status, e.g. "batch 2/5" or "fetching source txs 12/40" */
	detail?: string;
	txids: string[];
	error?: string;
}

export interface SweepProgress {
	message: string;
	/** 0-100, derived from completed work units — never fabricated */
	percent: number;
	steps: SweepStepState[];
}

export interface SweepResult {
	bsvTxids: string[];
	ordinalTxids: string[];
	bsv20Txids: string[];
	bsv21Txids: string[];
	/** Wallet-owned listings cancelled before the sweep */
	cancelTxids?: string[];
	/** Moves from the pay-key wallet to the identity root's deposit address */
	transferTxids?: string[];
	/** Listed legacy outputs whose OrdLock was cancelled inside a sweep spend */
	cancelledListings: string[];
	errors: string[];
}

export function emptySweepResult(
	extra: Partial<SweepResult> = {},
): SweepResult {
	return {
		bsvTxids: [],
		ordinalTxids: [],
		bsv20Txids: [],
		bsv21Txids: [],
		cancelledListings: [],
		errors: [],
		...extra,
	};
}

/** Listings cancelled by a migration: wallet-owned ones plus listed legacy outputs swept. */
export function cancelledListingCount(result: SweepResult): number {
	return (result.cancelTxids?.length ?? 0) + result.cancelledListings.length;
}

/** The @1sat/actions calls the sweep makes; injectable for tests. */
export interface SweepActions {
	prepareSweepInputs: typeof prepareSweepInputs;
	sweepBsv: typeof sweepBsv.execute;
	sweepOrdinals: typeof sweepOrdinals.execute;
	sweepBsv20: typeof sweepBsv20.execute;
	sweepBsv21: typeof sweepBsv21.execute;
}

const defaultSweepActions: SweepActions = {
	prepareSweepInputs,
	sweepBsv: sweepBsv.execute,
	sweepOrdinals: sweepOrdinals.execute,
	sweepBsv20: sweepBsv20.execute,
	sweepBsv21: sweepBsv21.execute,
};

/** Everything a sweep run needs besides the keys that sign it. */
interface SweepRunOptions {
	wallet: WalletInterface;
	services: OneSatServices;
	chain?: "main" | "test";
	onProgress: (progress: SweepProgress) => void;
	funding: IndexedOutput[];
	ordinals: IndexedOutput[];
	bsv21Tokens: TokenBalance[];
	/** BSV-20 balances grouped by ticker (groupBsv20Tokens) */
	bsv20Tokens?: Bsv20Balance[];
	actions?: Partial<SweepActions>;
}

export interface MigrationSweepParams extends SweepRunOptions {
	legacyPayWif: string;
	legacyOrdWif: string;
	legacyIdentityWif?: string;
}

/** One signing key for a sweep, named for the messages that mention it. */
export interface SweepKey {
	/** Shown in errors, e.g. "Legacy pay" or "Pasted"; never the key itself */
	label: string;
	wif: string;
}

export interface KeySweepParams extends SweepRunOptions {
	/** Every key whose address the outputs may name in their own: events */
	keys: readonly SweepKey[];
}

const chunk = <T>(items: T[], size: number): T[][] => {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size));
	}
	return out;
};

/**
 * Resolve the signing key for each output from its own: events, as
 * @1sat/sweep-ui's buildKeys does: every own: event is considered and
 * exactly one must name one of our legacy addresses. Zero or several
 * matches is a hard error BEFORE building the tx, so nothing is signed
 * with a guessed key.
 */
export const buildKeys = (
	outputs: IndexedOutput[],
	keyMap: Map<string, PrivateKey>,
): PrivateKey[] =>
	outputs.map((output) => {
		const owners = [
			...new Set(
				(output.events ?? [])
					.filter((e) => e.startsWith("own:"))
					.map((e) => e.slice(4)),
			),
		];
		const matches = owners.filter((owner) => keyMap.has(owner));
		if (matches.length !== 1) {
			throw new Error(
				matches.length === 0
					? `No key for output ${output.outpoint} (owner: ${owners.join(",") || "unknown"})`
					: `Output ${output.outpoint} names more than one of this wallet's legacy addresses (${matches.join(",")}); not signing`,
			);
		}
		return keyMap.get(matches[0]) as PrivateKey;
	});

/**
 * Canonical `txid.vout` for comparing outpoints across the indexer, overlay
 * and SDK. An unparseable outpoint is compared as written; its own prepare
 * or sweep call reports it.
 */
const canonicalOutpoint = (outpoint: string): string => {
	try {
		return normalizeOutpoint(outpoint);
	} catch {
		return outpoint;
	}
};

/**
 * Token amount for an output, looked up by canonical outpoint (the indexer,
 * overlay and SDK mix `.` and `_`). A missing amount is an error: sweeping a
 * token input with an amount of 0 would drop its balance from the transfer.
 */
const tokenAmountLookup = (amounts: Map<string, string>, label: string) => {
	const byOutpoint = new Map(
		[...amounts].map(([outpoint, amount]) => [
			canonicalOutpoint(outpoint),
			amount,
		]),
	);
	return (outpoint: string): string => {
		const amount = byOutpoint.get(canonicalOutpoint(outpoint));
		if (!amount) {
			throw new Error(`${label}: no token amount for output ${outpoint}`);
		}
		return amount;
	};
};

interface PreparedInputs {
	/** Outputs whose locking scripts were resolved, with their sweep inputs */
	prepared: {
		output: IndexedOutput;
		input: Awaited<ReturnType<typeof prepareSweepInputs>>[number];
	}[];
	/** Outputs skipped because their source tx could not be fetched */
	failures: { outpoint: string; error: string }[];
}

/**
 * Prepare sweep inputs with bounded concurrency and per-txid failure
 * isolation. prepareSweepInputs fetches BEEFs serially and throws on the
 * first failure — for old addresses with hundreds of source txs that is
 * both slow and all-or-nothing. Here each source txid is fetched
 * independently (up to PREPARE_CONCURRENCY at once); a txid that can't be
 * resolved skips only its own outputs.
 */
async function prepareInputsConcurrent(
	prepare: SweepActions["prepareSweepInputs"],
	ctx: Parameters<typeof prepareSweepInputs>[0],
	outputs: IndexedOutput[],
	onDetail?: (done: number, total: number) => void,
): Promise<PreparedInputs> {
	const byTxid = new Map<string, IndexedOutput[]>();
	for (const output of outputs) {
		const txid = output.outpoint.split(/[._]/)[0];
		const group = byTxid.get(txid) ?? [];
		group.push(output);
		byTxid.set(txid, group);
	}

	const groups = [...byTxid.entries()];
	const prepared: PreparedInputs["prepared"] = [];
	const failures: PreparedInputs["failures"] = [];
	let done = 0;
	let cursor = 0;

	const worker = async () => {
		while (cursor < groups.length) {
			const index = cursor++;
			const [txid, groupOutputs] = groups[index];
			try {
				const inputs = await prepare(ctx, groupOutputs);
				const byOutpoint = new Map(inputs.map((i) => [i.outpoint, i]));
				for (const output of groupOutputs) {
					const input = byOutpoint.get(output.outpoint);
					if (input?.lockingScript) {
						prepared.push({ output, input });
					} else {
						failures.push({
							outpoint: output.outpoint,
							error: "missing locking script",
						});
					}
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				for (const output of groupOutputs) {
					failures.push({
						outpoint: output.outpoint,
						error: `source tx ${txid.slice(0, 12)}...: ${message}`,
					});
				}
			}
			done++;
			onDetail?.(done, groups.length);
		}
	};

	await Promise.all(
		Array.from(
			{ length: Math.min(PREPARE_CONCURRENCY, groups.length) },
			worker,
		),
	);

	return { prepared, failures };
}

/** The migration's three named legacy keys as a key list; unset ones are left out. */
export function migrationSweepKeys(
	params: Pick<
		MigrationSweepParams,
		"legacyPayWif" | "legacyOrdWif" | "legacyIdentityWif"
	>,
): SweepKey[] {
	const keys: [string, string | undefined][] = [
		["Legacy pay", params.legacyPayWif],
		["Legacy ord", params.legacyOrdWif],
		["Legacy identity", params.legacyIdentityWif],
	];
	return keys.flatMap(([label, wif]) => (wif ? [{ label, wif }] : []));
}

/**
 * Sweep legacy assets into the BRC-100 wallet. Mirrors the yours-wallet /
 * @1sat/sweep-ui sweeper — BEEF-derived locking scripts, per-output key
 * resolution from own: events, overlay-validated BSV-21 amounts — with
 * chunked transactions and structured progress on top.
 */
export async function executeMigrationSweep(
	params: MigrationSweepParams,
): Promise<SweepResult> {
	const { legacyPayWif, legacyOrdWif, legacyIdentityWif, ...options } = params;
	return executeKeySweep({
		...options,
		keys: migrationSweepKeys({ legacyPayWif, legacyOrdWif, legacyIdentityWif }),
	});
}

/**
 * The sweep engine behind executeMigrationSweep, for any list of keys: each
 * output is signed by the one key whose address its own: events name.
 */
export async function executeKeySweep(
	params: KeySweepParams,
): Promise<SweepResult> {
	const {
		wallet,
		services,
		chain = "main",
		keys,
		onProgress,
		funding,
		ordinals,
		bsv21Tokens,
		bsv20Tokens = [],
	} = params;
	const actions: SweepActions = { ...defaultSweepActions, ...params.actions };

	const ctx = createContext(wallet, { services, chain });

	const result = emptySweepResult();

	const keyMap = new Map<string, PrivateKey>();
	for (const { label, wif } of keys) {
		try {
			const key = PrivateKey.fromWif(wif);
			keyMap.set(key.toPublicKey().toAddress(), key);
		} catch (error) {
			// Never the WIF itself: only which key and why it did not parse.
			console.error(
				`[migration] ${label.toLowerCase()} key could not be read`,
				error,
			);
			result.errors.push(
				`${label} key could not be read (${error instanceof Error ? error.message : String(error)}); outputs at its address were not swept.`,
			);
		}
	}

	const fundingChunks = chunk(funding, FUNDING_CHUNK_SIZE);
	const ordinalChunks = isolateListedBatches(ordinals, ORDINAL_CHUNK_SIZE);
	const activeTokens = excludeUnsweepableTokens(bsv21Tokens).filter(
		(t) => t.outputs.length > 0,
	);
	// Only amounts the indexer gives are swept (see splitBsv20Outputs); an
	// amount from the inscription JSON alone could over-claim and burn.
	const activeBsv20 = bsv20Tokens
		.map((t) => {
			const unconfirmed = t.outputs.filter((o) => !hasIndexedBsv20Amount(o));
			for (const o of unconfirmed) {
				result.errors.push(
					`BSV-20 ${t.tick} output ${o.outpoint} was not swept: ${BSV20_UNCONFIRMED_REASON}.`,
				);
			}
			return unconfirmed.length === 0
				? t
				: { ...t, outputs: t.outputs.filter(hasIndexedBsv20Amount) };
		})
		.filter((t) => t.outputs.length > 0);
	const bsv20Batches = new Map(
		activeBsv20.map((t) => [
			t.tick,
			isolateListedBatches(t.outputs, TOKEN_CHUNK_SIZE),
		]),
	);
	const bsv21Batches = new Map(
		activeTokens.map((t) => [
			t.tokenId,
			isolateListedBatches(t.outputs, TOKEN_CHUNK_SIZE),
		]),
	);

	// Build the step list up front so the UI can render the full plan
	const steps: SweepStepState[] = [];
	if (funding.length > 0) {
		steps.push({
			id: "bsv",
			label: `BSV funding (${funding.length} UTXO${funding.length !== 1 ? "s" : ""})`,
			status: "pending",
			txids: [],
		});
	}
	if (ordinals.length > 0) {
		steps.push({
			id: "ordinals",
			label: `Ordinals (${ordinals.length})`,
			status: "pending",
			txids: [],
		});
	}
	for (const token of activeBsv20) {
		steps.push({
			id: `bsv20:${token.tick}`,
			label: `${token.tick} (${token.outputs.length} output${token.outputs.length !== 1 ? "s" : ""})`,
			status: "pending",
			txids: [],
		});
	}
	for (const token of activeTokens) {
		steps.push({
			id: `token:${token.tokenId}`,
			label: `${token.symbol ?? token.tokenId.slice(0, 8)} (${token.outputs.length} output${token.outputs.length !== 1 ? "s" : ""})`,
			status: "pending",
			txids: [],
		});
	}

	const totalUnits =
		fundingChunks.length +
		ordinalChunks.length +
		[...bsv20Batches.values(), ...bsv21Batches.values()].reduce(
			(sum, batches) => sum + batches.length,
			0,
		);
	let completedUnits = 0;

	const emit = (message: string) => {
		onProgress({
			message,
			percent:
				totalUnits === 0
					? 100
					: Math.round((completedUnits / totalUnits) * 100),
			steps: steps.map((s) => ({ ...s, txids: [...s.txids] })),
		});
	};

	const stepById = (id: string) => steps.find((s) => s.id === id);

	if (steps.length === 0) {
		emit("No assets found at legacy addresses");
		return result;
	}

	emit("Starting sweep...");

	// Sweep one category in chunked transactions. Every chunk prepares its
	// own inputs, so partial failures surface as per-chunk errors while the
	// rest of the sweep keeps going.
	const sweepChunked = async (
		stepId: string,
		errorLabel: string,
		chunks: IndexedOutput[][],
		execute: (
			prepared: PreparedInputs["prepared"],
			keys: PrivateKey[],
		) => Promise<{ txid?: string; error?: string; spentOutpoints?: string[] }>,
		collect: (txid: string) => void,
	) => {
		const step = stepById(stepId);
		if (!step) return;
		step.status = "active";
		let failedChunks = 0;

		for (let i = 0; i < chunks.length; i++) {
			const batchLabel =
				chunks.length > 1 ? ` (batch ${i + 1}/${chunks.length})` : "";
			let chunkFailed = false;
			try {
				step.detail = `preparing inputs${batchLabel}`;
				emit(`${errorLabel}: preparing inputs${batchLabel}...`);

				const { prepared, failures } = await prepareInputsConcurrent(
					actions.prepareSweepInputs,
					ctx,
					chunks[i],
					(done, total) => {
						step.detail = `fetching source txs ${done}/${total}${batchLabel}`;
						emit(`${errorLabel}: fetching source txs ${done}/${total}...`);
					},
				);

				for (const failure of failures) {
					result.errors.push(
						`${errorLabel}: skipped ${failure.outpoint} (${failure.error})`,
					);
				}
				// A skipped output stays at the legacy address: the step is
				// not done even when the rest of the chunk goes through.
				if (failures.length > 0) chunkFailed = true;

				if (prepared.length > 0) {
					step.detail = `broadcasting${batchLabel}`;
					emit(`${errorLabel}: broadcasting${batchLabel}...`);

					const keys = buildKeys(
						prepared.map((p) => p.output),
						keyMap,
					);
					const txResult = await execute(prepared, keys);

					if (txResult.error) {
						chunkFailed = true;
						console.error(
							`[migration] ${errorLabel}${batchLabel} failed`,
							txResult.error,
						);
						result.errors.push(`${errorLabel}${batchLabel}: ${txResult.error}`);
					} else if (txResult.txid) {
						collect(txResult.txid);
						step.txids.push(txResult.txid);
						// The BSV-21 sweep spends only the inputs the overlay accepted
						// and reports them; any other input is still at the legacy
						// address and must not read as swept.
						const spent = txResult.spentOutpoints
							? new Set(txResult.spentOutpoints.map(canonicalOutpoint))
							: null;
						const outputs = prepared.map((p) => p.output);
						const swept = spent
							? outputs.filter((o) => spent.has(canonicalOutpoint(o.outpoint)))
							: outputs;
						const left = spent
							? outputs.filter((o) => !spent.has(canonicalOutpoint(o.outpoint)))
							: [];
						if (left.length > 0) {
							chunkFailed = true;
							result.errors.push(
								`${errorLabel}${batchLabel}: ${left.length} output${left.length !== 1 ? "s were" : " was"} not accepted by the token overlay and stayed at the legacy address (${left.map((o) => o.outpoint).join(", ")})`,
							);
						}
						for (const output of swept) {
							if (isListedOutput(output)) {
								result.cancelledListings.push(output.outpoint);
							}
						}
					} else {
						chunkFailed = true;
						result.errors.push(
							`${errorLabel}${batchLabel}: the sweep returned no transaction id`,
						);
					}
				}
			} catch (error) {
				chunkFailed = true;
				console.error(`[migration] ${errorLabel}${batchLabel} failed`, error);
				result.errors.push(
					`${errorLabel}${batchLabel}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (chunkFailed) failedChunks++;
			completedUnits++;
			emit(`${errorLabel}: batch ${i + 1}/${chunks.length} complete`);
		}

		step.detail = undefined;
		step.status =
			failedChunks > 0 || step.txids.length === 0 ? "error" : "done";
		if (failedChunks > 0) {
			step.error = `${failedChunks} of ${chunks.length} batch${chunks.length !== 1 ? "es" : ""} failed`;
		}
		emit(`${errorLabel} complete`);
	};

	// 1. BSV funding
	if (fundingChunks.length > 0) {
		await sweepChunked(
			"bsv",
			"BSV sweep",
			fundingChunks,
			(prepared, keys) =>
				actions.sweepBsv(ctx, {
					inputs: prepared.map((p) => p.input),
					keys,
				}),
			(txid) => result.bsvTxids.push(txid),
		);
	}

	// 2. Ordinals (listed ordinals are swept via OrdLock cancel inside the
	// action, one per tx so a v1 or bad listing fails alone; BSV-20 content is
	// refused by the action's guard)
	if (ordinalChunks.length > 0) {
		await sweepChunked(
			"ordinals",
			"Ordinal sweep",
			ordinalChunks,
			(prepared, keys) =>
				actions.sweepOrdinals(ctx, {
					inputs: prepared.map((p) => p.input),
					keys,
				}),
			(txid) => result.ordinalTxids.push(txid),
		);
	}

	// 3. BSV-20 tokens — one step per ticker, listed outputs one per tx,
	// amounts parsed by groupBsv20Tokens (same order as @1sat/sweep-ui)
	for (const token of activeBsv20) {
		const amountOf = tokenAmountLookup(token.amounts, `BSV-20 ${token.tick}`);
		await sweepChunked(
			`bsv20:${token.tick}`,
			`BSV-20 ${token.tick}`,
			bsv20Batches.get(token.tick) ?? [],
			(prepared, keys) =>
				actions.sweepBsv20(ctx, {
					inputs: prepared.map((p) => ({
						...p.input,
						tick: token.tick,
						amount: amountOf(p.output.outpoint),
					})),
					keys,
				}),
			(txid) => result.bsv20Txids.push(txid),
		);
	}

	// 4. BSV-21 tokens — chunked per token with listed outputs one per tx,
	// amounts from the overlay-validated map (never the origin mint amount),
	// inactive tokens skipped
	for (const token of activeTokens) {
		const label = token.symbol ?? token.tokenId.slice(0, 8);
		const step = stepById(`token:${token.tokenId}`);
		const batches = bsv21Batches.get(token.tokenId) ?? [];
		if (!token.isActive) {
			if (step) {
				step.status = "error";
				step.error = "not validated on the overlay — skipped";
			}
			result.errors.push(`Token ${label}: not active on the overlay — skipped`);
			completedUnits += batches.length;
			emit(`Token ${label} skipped`);
			continue;
		}

		const amountOf = tokenAmountLookup(token.amounts, `Token ${label}`);
		await sweepChunked(
			`token:${token.tokenId}`,
			`Token ${label}`,
			batches,
			(prepared, keys) =>
				actions.sweepBsv21(ctx, {
					inputs: prepared.map((p) => ({
						...p.input,
						tokenId: token.tokenId,
						amount: amountOf(p.output.outpoint),
					})),
					keys,
				}),
			(txid) => result.bsv21Txids.push(txid),
		);
	}

	emit("Sweep complete");
	return result;
}
