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
import { Beef, PrivateKey, type WalletInterface } from "@bsv/sdk";
import {
	BSV20_UNCONFIRMED_REASON,
	excludeUnsweepableTokens,
	hasIndexedBsv20Amount,
	isListedOutput,
	isolateListedBatches,
} from "@/lib/wallet/migration-listings";

/**
 * wallet.1sat.app's request body limit: 8 MiB. Measured 2026-11-17 against
 * the live server: a request of 8,323,134 bytes reached auth (401); 8 MiB
 * (8,388,608 bytes) and above got 413 ERR_BODY_TOO_LARGE. Matches the
 * 8 << 20 BEEF bound in opldotdev/swift-wallet-toolbox StorageLimits.swift.
 */
export const WALLET_SERVER_MAX_REQUEST_BYTES = 8 * 1024 * 1024;

/**
 * Bytes a binary field such as inputBEEF takes in the createAction request
 * body. @1sat/wallet's factory creates its StorageClient with
 * binaryRequests: true, and wallet.1sat.app answers with
 * X-BSV-Binary-Encoding: base64 (checked 2026-11-17: makeAvailable leaves
 * serverSupportsBinary true), so @bsv/wallet-toolbox-client's
 * binaryJsonReplacer writes it as {"$bsvBinary":"base64","data":"<base64>"}.
 */
const BINARY_FIELD_WRAPPER_BYTES = JSON.stringify({
	$bsvBinary: "base64",
	data: "",
}).length;
export const encodedBinaryBytes = (bytes: number): number =>
	BINARY_FIELD_WRAPPER_BYTES + 4 * Math.ceil(bytes / 3);

/**
 * Bytes one input descriptor takes in the request body, measured from the
 * shape @1sat/actions' sweep actions build (the longest of their
 * descriptions), with its separating comma.
 */
const inputDescriptorBytes = (outpoint: string): number =>
	JSON.stringify({
		outpoint,
		inputDescription: `Token input ${outpoint}`,
		unlockingScriptLength: 108,
		sequenceNumber: 0xffffffff,
	}).length + 1;

/** Concurrent BEEF fetches during input preparation */
const PREPARE_CONCURRENCY = 6;

export interface SweepStepState {
	id: string;
	label: string;
	status: "pending" | "active" | "done" | "error";
	/** Live sub-status, e.g. "batch 2/5" or "fetching source txs 12/40" */
	detail?: string;
	txids: string[];
	/** Short summary of what failed, e.g. "1 of 2 batches failed" */
	error?: string;
	/** Every error this step raised, verbatim (also in SweepResult.errors) */
	errors?: string[];
}

/**
 * An output a sweep run left at its address, and why: the exact error that
 * kept it there. Reporting only (the run's audit record); never read by the
 * sweep itself.
 */
export interface SweepLeftBehind {
	outpoint: string;
	/** The step it belonged to, when it reached one */
	stepId?: string;
	reason: string;
	/** Its source transaction, when the reason is about that transaction */
	txid?: string;
	/** Byte sizes behind the reason: the source tx and its BEEF */
	txBytes?: number;
	beefBytes?: number;
	/** The exact underlying error or check result, when `reason` is plain words */
	detail?: string;
}

export interface SweepProgress {
	message: string;
	/** 0-100, derived from completed work units — never fabricated */
	percent: number;
	steps: SweepStepState[];
	/** Every error so far, verbatim (SweepResult.errors as it stands) */
	errors?: string[];
	/** Outputs left behind so far (SweepResult.leftBehind as it stands) */
	leftBehind?: SweepLeftBehind[];
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
	/** Outputs this run left at their address, each with its exact reason */
	leftBehind?: SweepLeftBehind[];
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
		leftBehind: [],
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
	/** Prefix for this run's console logs; the migration's is "[migration]" */
	logPrefix?: string;
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

type SweepInput = Awaited<ReturnType<typeof prepareSweepInputs>>[number];

/** An output with the sweep input built from its source tx. */
interface PreparedInput {
	output: IndexedOutput;
	input: SweepInput;
}

/** A source transaction a batch spends from, with its BEEF's sizes. */
interface SweepSource {
	txid: string;
	outputs: IndexedOutput[];
	/** Serialized BEEF of the source tx, as the indexer served it */
	beefBytes: number;
	/** The source tx alone */
	txBytes: number;
	txCount: number;
	bumpCount: number;
}

const txidOf = (outpoint: string): string => outpoint.split(/[._]/)[0];

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** "8.4 MB" / "640 KB": sizes for messages people read. */
export const formatBytes = (bytes: number): string =>
	bytes >= 1_000_000
		? `${(bytes / 1_000_000).toFixed(1)} MB`
		: `${Math.max(1, Math.round(bytes / 1_000))} KB`;

/**
 * True for the wallet server refusing a request body as too large:
 * @bsv/wallet-toolbox-client's StorageClient throws
 * "WalletStorageClient rpcCall: network error 413" for it.
 */
export const isRequestTooLarge = (error: unknown): boolean =>
	/\bnetwork error 413(?:\s|$)|ERR_BODY_TOO_LARGE/.test(errorMessage(error));

/** What the sweep actions did with the wallet during one attempt. */
interface WalletCallTrace {
	/** The error createAction threw, if it threw */
	createActionError?: unknown;
	/** signAction is the call that signs and broadcasts */
	signActionCalls: number;
}

/**
 * The wallet as the sweep actions see it, recording createAction failures
 * and signAction calls into the current attempt's trace. Every sweep action
 * (sweepBsv, sweepOrdinals, sweepBsv20, sweepBsv21) runs executeTrackedAction:
 * wallet.createAction with signAndProcess: false, then completeSignedAction,
 * which signs locally and calls wallet.signAction to broadcast. A createAction
 * that threw means nothing was signed or broadcast, which is the only case
 * the sweep retries.
 */
function traceWallet(
	wallet: WalletInterface,
	current: () => WalletCallTrace,
): WalletInterface {
	// The proxy's own target is a blank object, so a frozen wallet's
	// properties never bind the trap to returning them unwrapped.
	const target = wallet;
	return new Proxy({} as WalletInterface, {
		has: (_, prop) => Reflect.has(target, prop),
		get(_, prop) {
			const value = Reflect.get(target, prop, target);
			if (typeof value !== "function") return value;
			if (prop === "createAction") {
				return async (...args: unknown[]) => {
					try {
						return await value.apply(target, args);
					} catch (error) {
						current().createActionError = error;
						throw error;
					}
				};
			}
			if (prop === "signAction") {
				return (...args: unknown[]) => {
					current().signActionCalls++;
					return value.apply(target, args);
				};
			}
			return value.bind(target);
		},
	});
}

/**
 * The services as the sweep sees them: getBeefForTxid answers from the BEEFs
 * this run already fetched and checked, so a batch's source txs are fetched
 * once (not again by prepareSweepInputs and again by the action), and the
 * action is sent exactly the BEEF that was checked. Each call gets its own
 * copy, since the actions merge into the first BEEF they get.
 */
function cachedBeefServices(
	services: OneSatServices,
	cache: Map<string, number[]>,
): OneSatServices {
	const target = services;
	return new Proxy({} as OneSatServices, {
		has: (_, prop) => Reflect.has(target, prop),
		get(_, prop) {
			if (prop === "getBeefForTxid") {
				return async (txid: string) => {
					const cached = cache.get(txid);
					if (cached) return Beef.fromBinary(cached);
					return target.getBeefForTxid(txid);
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/** Runs `work` over `items`, at most `limit` at once, results in order. */
async function mapConcurrent<T, R>(
	items: readonly T[],
	limit: number,
	work: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let cursor = 0;
	const worker = async () => {
		while (cursor < items.length) {
			const index = cursor++;
			results[index] = await work(items[index]);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, worker),
	);
	return results;
}

/** Outputs grouped by source txid, in first-seen order. */
function groupBySourceTx(
	outputs: IndexedOutput[],
): [string, IndexedOutput[]][] {
	const byTxid = new Map<string, IndexedOutput[]>();
	for (const output of outputs) {
		const txid = txidOf(output.outpoint);
		const group = byTxid.get(txid) ?? [];
		group.push(output);
		byTxid.set(txid, group);
	}
	return [...byTxid.entries()];
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
		logPrefix = "[migration]",
	} = params;
	const actions: SweepActions = { ...defaultSweepActions, ...params.actions };

	// The current batch attempt's record of wallet calls (see traceWallet)
	let trace: WalletCallTrace = { signActionCalls: 0 };
	// BEEFs fetched and checked for the batch being built, by txid
	const beefCache = new Map<string, number[]>();
	const ctx = createContext(
		traceWallet(wallet, () => trace),
		{ services: cachedBeefServices(services, beefCache), chain },
	);

	const result = emptySweepResult();
	const leftBehind: SweepLeftBehind[] = [];
	result.leftBehind = leftBehind;

	const keyMap = new Map<string, PrivateKey>();
	for (const { label, wif } of keys) {
		try {
			const key = PrivateKey.fromWif(wif);
			keyMap.set(key.toPublicKey().toAddress(), key);
		} catch (error) {
			// Never the WIF itself: only which key and why it did not parse.
			console.error(
				`${logPrefix} ${label.toLowerCase()} key could not be read`,
				error,
			);
			result.errors.push(
				`${label} key could not be read (${error instanceof Error ? error.message : String(error)}); outputs at its address were not swept.`,
			);
		}
	}

	const activeTokens = excludeUnsweepableTokens(bsv21Tokens).filter(
		(t) => t.outputs.length > 0,
	);
	const sweptTokens = new Set(activeTokens);
	for (const token of bsv21Tokens) {
		if (sweptTokens.has(token)) continue;
		for (const o of token.outputs) {
			leftBehind.push({
				outpoint: o.outpoint,
				reason: `Token ${token.symbol ?? token.tokenId.slice(0, 8)}: not swept (this token's outputs can't be signed by the generic sweep)`,
			});
		}
	}
	// Only amounts the indexer gives are swept (see splitBsv20Outputs); an
	// amount from the inscription JSON alone could over-claim and burn.
	const activeBsv20 = bsv20Tokens
		.map((t) => {
			const unconfirmed = t.outputs.filter((o) => !hasIndexedBsv20Amount(o));
			for (const o of unconfirmed) {
				const message = `BSV-20 ${t.tick} output ${o.outpoint} was not swept: ${BSV20_UNCONFIRMED_REASON}.`;
				result.errors.push(message);
				leftBehind.push({ outpoint: o.outpoint, reason: message });
			}
			return unconfirmed.length === 0
				? t
				: { ...t, outputs: t.outputs.filter(hasIndexedBsv20Amount) };
		})
		.filter((t) => t.outputs.length > 0);

	// Build the step list up front so the UI can render the full plan
	const steps: SweepStepState[] = [];
	if (funding.length > 0) {
		steps.push({
			id: "bsv",
			label: `BSV funding (${funding.length} UTXO${funding.length !== 1 ? "s" : ""})`,
			status: "pending",
			txids: [],
			errors: [],
		});
	}
	if (ordinals.length > 0) {
		steps.push({
			id: "ordinals",
			label: `Ordinals (${ordinals.length})`,
			status: "pending",
			txids: [],
			errors: [],
		});
	}
	for (const token of activeBsv20) {
		steps.push({
			id: `bsv20:${token.tick}`,
			label: `${token.tick} (${token.outputs.length} output${token.outputs.length !== 1 ? "s" : ""})`,
			status: "pending",
			txids: [],
			errors: [],
		});
	}
	for (const token of activeTokens) {
		steps.push({
			id: `token:${token.tokenId}`,
			label: `${token.symbol ?? token.tokenId.slice(0, 8)} (${token.outputs.length} output${token.outputs.length !== 1 ? "s" : ""})`,
			status: "pending",
			txids: [],
			errors: [],
		});
	}

	// Progress counts outputs settled (swept or left with a reason): batches
	// are packed by size as the sweep goes, so their number isn't known ahead.
	const totalUnits =
		funding.length +
		ordinals.length +
		activeBsv20.reduce((sum, t) => sum + t.outputs.length, 0) +
		activeTokens.reduce((sum, t) => sum + t.outputs.length, 0);
	let completedUnits = 0;

	const emit = (message: string) => {
		onProgress({
			message,
			percent:
				totalUnits === 0
					? 100
					: Math.round((completedUnits / totalUnits) * 100),
			steps: steps.map((s) => ({
				...s,
				txids: [...s.txids],
				errors: [...(s.errors ?? [])],
			})),
			errors: [...result.errors],
			leftBehind: [...leftBehind],
		});
	};

	const stepById = (id: string) => steps.find((s) => s.id === id);

	if (steps.length === 0) {
		emit("No assets found at legacy addresses");
		return result;
	}

	emit("Starting sweep...");

	// Sweep one category. Listed outputs go one per transaction; the rest are
	// packed into transactions by the size of their source BEEFs so each
	// createAction request fits the wallet server, and a request the server
	// still refuses as too large is split in half and retried. Every source
	// BEEF is checked before it is sent. Partial failures surface as errors on
	// the step while the rest of the sweep keeps going.
	const sweepChunked = async (
		stepId: string,
		errorLabel: string,
		outputs: IndexedOutput[],
		execute: (
			prepared: PreparedInput[],
			keys: PrivateKey[],
		) => Promise<{ txid?: string; error?: string; spentOutpoints?: string[] }>,
		collect: (txid: string) => void,
	) => {
		const step = stepById(stepId);
		if (!step) return;
		step.status = "active";
		let batchCount = 0;
		let failedBatches = 0;
		// Every error is recorded on the run, on its step, and against the
		// outputs it kept at the legacy address.
		const fail = (
			message: string,
			outpoints: readonly string[],
			extra: Omit<SweepLeftBehind, "outpoint" | "stepId" | "reason"> = {},
		) => {
			result.errors.push(message);
			step.errors?.push(message);
			for (const outpoint of outpoints) {
				leftBehind.push({ outpoint, stepId, reason: message, ...extra });
			}
		};
		const settle = (count: number) => {
			completedUnits += count;
		};
		const isOrdinals = stepId === "ordinals";

		// Fetch and check one source tx's BEEF; a bad one never reaches a batch.
		const loadSource = async (
			txid: string,
			sourceOutputs: IndexedOutput[],
		): Promise<SweepSource | null> => {
			let beef: Beef;
			try {
				beef = await services.getBeefForTxid(txid);
			} catch (error) {
				console.error(
					`${logPrefix} ${errorLabel}: source tx ${txid} could not be fetched`,
					error,
				);
				for (const output of sourceOutputs) {
					fail(
						`${errorLabel}: skipped ${output.outpoint} (source tx ${txid.slice(0, 12)}...: ${errorMessage(error)})`,
						[output.outpoint],
						{ txid },
					);
				}
				settle(sourceOutputs.length);
				return null;
			}
			const binary = beef.toBinary();
			const tx = beef.findTxid(txid)?.tx;
			const source: SweepSource = {
				txid,
				outputs: sourceOutputs,
				beefBytes: binary.length,
				txBytes: tx ? tx.toBinary().length : binary.length,
				txCount: beef.txs.length,
				bumpCount: beef.bumps.length,
			};
			if (!beef.isValid(false)) {
				const detail = `BEEF for source tx ${txid} is not valid (no merkle proof and no proven ancestors): ${source.beefBytes} bytes, ${source.txCount} txs, ${source.bumpCount} bumps`;
				console.error(`${logPrefix} ${errorLabel}: ${detail}; not sent`);
				for (const output of sourceOutputs) {
					fail(
						`${errorLabel}: ${output.outpoint} stays at your old address: its source transaction has no confirmation proof from the indexer yet; try again after it's confirmed.`,
						[output.outpoint],
						{
							txid,
							txBytes: source.txBytes,
							beefBytes: source.beefBytes,
							detail,
						},
					);
				}
				settle(sourceOutputs.length);
				return null;
			}
			beefCache.set(txid, binary);
			return source;
		};

		// Build sweep inputs (locking scripts) from the checked BEEFs.
		const prepareSources = async (
			sources: SweepSource[],
		): Promise<PreparedInput[]> => {
			const prepared: PreparedInput[] = [];
			for (const source of sources) {
				try {
					const inputs = await actions.prepareSweepInputs(ctx, source.outputs);
					const byOutpoint = new Map(inputs.map((i) => [i.outpoint, i]));
					for (const output of source.outputs) {
						const input = byOutpoint.get(output.outpoint);
						if (input?.lockingScript) {
							prepared.push({ output, input });
						} else {
							fail(
								`${errorLabel}: skipped ${output.outpoint} (missing locking script)`,
								[output.outpoint],
								{ txid: source.txid },
							);
							settle(1);
						}
					}
				} catch (error) {
					for (const output of source.outputs) {
						fail(
							`${errorLabel}: skipped ${output.outpoint} (source tx ${source.txid.slice(0, 12)}...: ${errorMessage(error)})`,
							[output.outpoint],
							{ txid: source.txid },
						);
					}
					settle(source.outputs.length);
				}
			}
			return prepared;
		};

		// Send one set of inputs. Returns false when any of them stayed behind.
		const send = async (
			prepared: PreparedInput[],
			sources: Map<string, SweepSource>,
			batchLabel: string,
		): Promise<boolean> => {
			const outpoints = prepared.map((p) => p.output.outpoint);
			let keysForInputs: PrivateKey[];
			try {
				keysForInputs = buildKeys(
					prepared.map((p) => p.output),
					keyMap,
				);
			} catch (error) {
				console.error(`${logPrefix} ${errorLabel}${batchLabel} failed`, error);
				fail(`${errorLabel}${batchLabel}: ${errorMessage(error)}`, outpoints);
				settle(outpoints.length);
				return false;
			}

			trace = { signActionCalls: 0 };
			let txResult: Awaited<ReturnType<typeof execute>>;
			try {
				txResult = await execute(prepared, keysForInputs);
			} catch (error) {
				txResult = { error: errorMessage(error) };
			}
			const attempt = trace;

			if (txResult.txid) {
				collect(txResult.txid);
				step.txids.push(txResult.txid);
				// The BSV-21 sweep spends only the inputs the overlay accepted
				// and reports them; any other input is still at the legacy
				// address and must not read as swept.
				const spent = txResult.spentOutpoints
					? new Set(txResult.spentOutpoints.map(canonicalOutpoint))
					: null;
				const batchOutputs = prepared.map((p) => p.output);
				const swept = spent
					? batchOutputs.filter((o) => spent.has(canonicalOutpoint(o.outpoint)))
					: batchOutputs;
				const left = spent
					? batchOutputs.filter(
							(o) => !spent.has(canonicalOutpoint(o.outpoint)),
						)
					: [];
				if (left.length > 0) {
					fail(
						`${errorLabel}${batchLabel}: ${left.length} output${left.length !== 1 ? "s were" : " was"} not accepted by the token overlay and stayed at the legacy address (${left.map((o) => o.outpoint).join(", ")})`,
						left.map((o) => o.outpoint),
					);
				}
				for (const output of swept) {
					if (isListedOutput(output)) {
						result.cancelledListings.push(output.outpoint);
					}
				}
				settle(outpoints.length);
				return left.length === 0;
			}

			// Too large for the wallet server. Retried only when createAction
			// itself was refused and signAction was never called: nothing was
			// signed or broadcast, so the same inputs can go again in halves.
			const refusedBeforeSigning =
				attempt.createActionError !== undefined &&
				isRequestTooLarge(attempt.createActionError) &&
				attempt.signActionCalls === 0;
			const txidsOf = (items: PreparedInput[]) => [
				...new Set(items.map((p) => txidOf(p.output.outpoint))),
			];
			const beefBytesOf = (items: PreparedInput[]) =>
				txidsOf(items).reduce(
					(sum, txid) => sum + (sources.get(txid)?.beefBytes ?? 0),
					0,
				);
			if (refusedBeforeSigning && prepared.length > 1) {
				const half = Math.ceil(prepared.length / 2);
				const halves = [prepared.slice(0, half), prepared.slice(half)];
				console.error(
					`${logPrefix} ${errorLabel}${batchLabel}: the wallet server refused the request as too large (${prepared.length} inputs, ${txidsOf(prepared).length} source txs, ${beefBytesOf(prepared)} BEEF bytes); splitting into ${halves[0].length} + ${halves[1].length} inputs (${beefBytesOf(halves[0])} + ${beefBytesOf(halves[1])} BEEF bytes)`,
					attempt.createActionError,
				);
				step.detail = `splitting a batch the wallet server refused as too large${batchLabel}`;
				emit(`${errorLabel}: splitting a batch that was too large...`);
				const first = await send(halves[0], sources, batchLabel);
				const second = await send(halves[1], sources, batchLabel);
				return first && second;
			}
			if (refusedBeforeSigning) {
				const [only] = prepared;
				const txid = txidOf(only.output.outpoint);
				const source = sources.get(txid);
				const txBytes = source?.txBytes ?? 0;
				const what = isOrdinals
					? "this inscription's transaction"
					: "this output's source transaction";
				const detail = errorMessage(attempt.createActionError);
				console.error(
					`${logPrefix} ${errorLabel}${batchLabel}: ${only.output.outpoint} alone is too large for the wallet server (source tx ${txid}: ${txBytes} tx bytes, ${source?.beefBytes ?? 0} BEEF bytes)`,
					attempt.createActionError,
				);
				fail(
					`${errorLabel}: ${only.output.outpoint}: ${what} is ${formatBytes(txBytes)}, more than the wallet server accepts in one request; it stays at your old address.`,
					[only.output.outpoint],
					{ txid, txBytes, beefBytes: source?.beefBytes, detail },
				);
				settle(1);
				return false;
			}

			console.error(
				`${logPrefix} ${errorLabel}${batchLabel} failed`,
				txResult.error ?? "the sweep returned no transaction id",
			);
			fail(
				`${errorLabel}${batchLabel}: ${txResult.error ?? "the sweep returned no transaction id"}`,
				outpoints,
			);
			settle(outpoints.length);
			return false;
		};

		// Send one packed batch, then let go of its BEEFs.
		const flush = async (sources: SweepSource[]) => {
			if (sources.length === 0) return;
			batchCount++;
			const batchLabel = ` (batch ${batchCount})`;
			step.detail = `preparing inputs${batchLabel}`;
			emit(`${errorLabel}: preparing inputs${batchLabel}...`);
			const before = leftBehind.length;
			const prepared = await prepareSources(sources);
			let ok = leftBehind.length === before;
			if (prepared.length > 0) {
				step.detail = `broadcasting${batchLabel}`;
				emit(`${errorLabel}: broadcasting${batchLabel}...`);
				const byTxid = new Map(sources.map((s) => [s.txid, s]));
				ok = (await send(prepared, byTxid, batchLabel)) && ok;
			}
			for (const source of sources) beefCache.delete(source.txid);
			if (!ok) failedBatches++;
			emit(`${errorLabel}: batch ${batchCount} complete`);
		};

		const budget = WALLET_SERVER_MAX_REQUEST_BYTES;
		// Listed outputs alone, one per transaction; the rest packed by size.
		for (const group of isolateListedBatches(
			outputs,
			Number.POSITIVE_INFINITY,
		)) {
			const sourceGroups = groupBySourceTx(group);
			let batch: SweepSource[] = [];
			let batchBeefBytes = 0;
			let batchInputBytes = 0;
			let fetchFailed = false;
			for (let i = 0; i < sourceGroups.length; i += PREPARE_CONCURRENCY) {
				const window = sourceGroups.slice(i, i + PREPARE_CONCURRENCY);
				step.detail = `fetching source txs ${Math.min(i + window.length, sourceGroups.length)}/${sourceGroups.length}`;
				emit(
					`${errorLabel}: fetching source txs ${Math.min(i + window.length, sourceGroups.length)}/${sourceGroups.length}...`,
				);
				const loaded = await mapConcurrent(
					window,
					PREPARE_CONCURRENCY,
					([txid, sourceOutputs]) => loadSource(txid, sourceOutputs),
				);
				for (const source of loaded) {
					if (!source) {
						fetchFailed = true;
						continue;
					}
					// The merged BEEF is at most the sum of its parts (shared
					// proofs and ancestors are stored once), so this bound keeps
					// the batch's encoded BEEF under the budget.
					const inputBytes = source.outputs.reduce(
						(sum, o) => sum + inputDescriptorBytes(o.outpoint),
						0,
					);
					const nextBeefBytes = batchBeefBytes + source.beefBytes;
					const nextSize =
						encodedBinaryBytes(nextBeefBytes) + batchInputBytes + inputBytes;
					if (batch.length > 0 && nextSize > budget) {
						await flush(batch);
						batch = [];
						batchBeefBytes = 0;
						batchInputBytes = 0;
					}
					// A source over the budget on its own goes alone; if the
					// server refuses it, it is reported with its size.
					batch.push(source);
					batchBeefBytes += source.beefBytes;
					batchInputBytes += inputBytes;
				}
			}
			await flush(batch);
			if (fetchFailed) failedBatches++;
		}

		step.detail = undefined;
		step.status =
			failedBatches > 0 || step.txids.length === 0 ? "error" : "done";
		if (failedBatches > 0) {
			const total = Math.max(batchCount, failedBatches);
			step.error = `${failedBatches} of ${total} batch${total !== 1 ? "es" : ""} failed`;
		}
		emit(`${errorLabel} complete`);
	};

	// 1. BSV funding
	if (funding.length > 0) {
		await sweepChunked(
			"bsv",
			"BSV sweep",
			funding,
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
	if (ordinals.length > 0) {
		await sweepChunked(
			"ordinals",
			"Ordinal sweep",
			ordinals,
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
			token.outputs,
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

	// 4. BSV-21 tokens — per token with listed outputs one per tx, amounts
	// from the overlay-validated map (never the origin mint amount), inactive
	// tokens skipped
	for (const token of activeTokens) {
		const label = token.symbol ?? token.tokenId.slice(0, 8);
		const step = stepById(`token:${token.tokenId}`);
		if (!token.isActive) {
			const message = `Token ${label}: not active on the overlay — skipped`;
			if (step) {
				step.status = "error";
				step.error = "not validated on the overlay — skipped";
				step.errors?.push(message);
			}
			result.errors.push(message);
			for (const o of token.outputs) {
				leftBehind.push({
					outpoint: o.outpoint,
					stepId: `token:${token.tokenId}`,
					reason: message,
				});
			}
			completedUnits += token.outputs.length;
			emit(`Token ${label} skipped`);
			continue;
		}

		const amountOf = tokenAmountLookup(token.amounts, `Token ${label}`);
		await sweepChunked(
			`token:${token.tokenId}`,
			`Token ${label}`,
			token.outputs,
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
