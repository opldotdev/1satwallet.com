import {
	bsv21FieldsFromOutput,
	listBsv21,
	type OneSatContext,
	parseBsv21CustomInstructions,
	type WalletOutput,
} from "@1sat/actions";
import type { IndexedOutput, TokenDetailResponse } from "@1sat/types";
import type { P2PTradeItem } from "../types/p2p";

const CANONICAL_OUTPOINT = /^([0-9a-f]{64})[._](0|[1-9][0-9]*)$/i;
const POSITIVE_ATOMIC_AMOUNT = /^[1-9][0-9]*$/;
const DEFAULT_TIMEOUT_MS = 12_000;
const VALIDATION_BATCH_SIZE = 1000;

export type Bsv21OfferValidationCode =
	| "invalid-offer"
	| "wallet-unavailable"
	| "wallet-read-failed"
	| "overlay-unavailable"
	| "overlay-timeout"
	| "token-inactive"
	| "overlay-mismatch"
	| "insufficient-coverage";

export type Bsv21OfferValidationResult =
	| {
			ok: true;
			coverage: Array<{
				tokenId: string;
				requestedAmount: string;
				validatedAmount: string;
			}>;
	  }
	| { ok: false; code: Bsv21OfferValidationCode; message: string };

interface Bsv21OfferValidationOptions {
	timeoutMs?: number;
}

interface OfferedToken {
	id: string;
	name: string;
	amount: bigint;
}

interface LocalCandidate {
	outpoint: string;
	tokenId: string;
	amount: bigint;
}

class ValidationTimeout extends Error {}

function failure(
	code: Bsv21OfferValidationCode,
	message: string,
): Bsv21OfferValidationResult {
	return { ok: false, code, message };
}

function canonicalOutpoint(value: string): string | null {
	const match = CANONICAL_OUTPOINT.exec(value.trim());
	if (!match) return null;
	return `${match[1].toLowerCase()}_${match[2]}`;
}

function readOffers(items: readonly P2PTradeItem[]): OfferedToken[] | null {
	const offered = new Map<string, OfferedToken>();
	for (const item of items) {
		if (item.type !== "bsv21") continue;
		const id = canonicalOutpoint(item.id);
		if (
			!id ||
			id !== item.id ||
			!POSITIVE_ATOMIC_AMOUNT.test(item.amount) ||
			item.amount.length > 80
		) {
			return null;
		}
		const amount = BigInt(item.amount);
		const previous = offered.get(id);
		if (previous) previous.amount += amount;
		else offered.set(id, { id, name: item.name, amount });
	}
	return [...offered.values()];
}

function localCandidate(output: WalletOutput): LocalCandidate | null {
	const outpoint = canonicalOutpoint(output.outpoint);
	if (!outpoint) return null;
	const fields = bsv21FieldsFromOutput({
		tags: output.tags,
		customInstructions: output.customInstructions,
		outpoint: output.outpoint,
	});
	const instructions = parseBsv21CustomInstructions(output.customInstructions);
	if (
		fields.isAuth ||
		instructions.op === "auth" ||
		instructions.op === "deploy+auth" ||
		!fields.tokenId ||
		!fields.amt ||
		!POSITIVE_ATOMIC_AMOUNT.test(fields.amt) ||
		fields.amt.length > 80
	) {
		return null;
	}
	const tokenId = canonicalOutpoint(fields.tokenId);
	if (!tokenId) return null;
	return { outpoint, tokenId, amount: BigInt(fields.amt) };
}

function collectCandidates(
	outputs: WalletOutput[],
	offeredIds: ReadonlySet<string>,
): Map<string, LocalCandidate[]> | null {
	const byToken = new Map<string, LocalCandidate[]>();
	const byOutpoint = new Map<string, LocalCandidate>();
	for (const output of outputs) {
		const candidate = localCandidate(output);
		if (!candidate || !offeredIds.has(candidate.tokenId)) continue;
		const previous = byOutpoint.get(candidate.outpoint);
		if (previous) {
			if (
				previous.tokenId !== candidate.tokenId ||
				previous.amount !== candidate.amount
			) {
				return null;
			}
			continue;
		}
		byOutpoint.set(candidate.outpoint, candidate);
		const tokenCandidates = byToken.get(candidate.tokenId) ?? [];
		tokenCandidates.push(candidate);
		byToken.set(candidate.tokenId, tokenCandidates);
	}
	return byToken;
}

function overlayToken(
	output: IndexedOutput,
): { tokenId: string; amount: bigint } | null {
	if (output.spend) return null;
	const data = output.data?.bsv21;
	if (!data || typeof data !== "object" || Array.isArray(data)) return null;
	const token = data as Record<string, unknown>;
	if (
		typeof token.id !== "string" ||
		typeof token.amt !== "string" ||
		!POSITIVE_ATOMIC_AMOUNT.test(token.amt) ||
		token.amt.length > 80 ||
		token.op === "auth" ||
		token.op === "deploy+auth"
	) {
		return null;
	}
	const tokenId = canonicalOutpoint(token.id);
	if (!tokenId) return null;
	return { tokenId, amount: BigInt(token.amt) };
}

function chunks<T>(values: T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < values.length; index += size) {
		result.push(values.slice(index, index + size));
	}
	return result;
}

async function validateToken(
	ctx: OneSatContext,
	offer: OfferedToken,
	candidates: LocalCandidate[],
): Promise<Bsv21OfferValidationResult> {
	const service = ctx.services?.bsv21;
	if (!service) {
		return failure(
			"overlay-unavailable",
			"BSV21 verification is unavailable. Check the wallet connection and try again.",
		);
	}
	let details: TokenDetailResponse;
	try {
		details = await service.getTokenDetails(offer.id);
	} catch {
		return failure(
			"overlay-unavailable",
			`Could not verify ${offer.name} with the BSV21 overlay. Check your connection and try again.`,
		);
	}
	if (
		canonicalOutpoint(details.tokenId) !== offer.id ||
		canonicalOutpoint(details.token.id) !== offer.id ||
		canonicalOutpoint(details.status.token_id) !== offer.id
	) {
		return failure(
			"overlay-mismatch",
			`The wallet and overlay disagree about ${offer.name}. Refresh the wallet before locking.`,
		);
	}
	if (!details.status.is_active) {
		return failure(
			"token-inactive",
			`${offer.name} is not active in the BSV21 overlay and cannot be locked.`,
		);
	}
	if (candidates.length === 0) {
		return failure(
			"insufficient-coverage",
			`This wallet no longer has enough verified ${offer.name} to cover the offer. Refresh and choose a smaller amount.`,
		);
	}

	const localByOutpoint = new Map(
		candidates.map((candidate) => [candidate.outpoint, candidate]),
	);
	let validatedRows: IndexedOutput[];
	try {
		const batches = await Promise.all(
			chunks(candidates, VALIDATION_BATCH_SIZE).map((batch) =>
				service.validateOutputs(
					offer.id,
					batch.map((candidate) => candidate.outpoint),
					{ unspent: true, tags: "bsv21" },
				),
			),
		);
		validatedRows = batches.flat();
	} catch {
		return failure(
			"overlay-unavailable",
			`Could not verify spendable ${offer.name} outputs. Check your connection and try again.`,
		);
	}

	const seen = new Set<string>();
	let validatedAmount = 0n;
	for (const row of validatedRows) {
		const outpoint = canonicalOutpoint(row.outpoint);
		const overlay = overlayToken(row);
		const local = outpoint ? localByOutpoint.get(outpoint) : undefined;
		if (
			!outpoint ||
			!overlay ||
			!local ||
			seen.has(outpoint) ||
			overlay.tokenId !== offer.id ||
			overlay.tokenId !== local.tokenId ||
			overlay.amount !== local.amount
		) {
			return failure(
				"overlay-mismatch",
				`The wallet and overlay disagree about ${offer.name}. Refresh the wallet before locking.`,
			);
		}
		seen.add(outpoint);
		validatedAmount += local.amount;
	}
	if (validatedAmount < offer.amount) {
		return failure(
			"insufficient-coverage",
			`This wallet no longer has enough verified ${offer.name} to cover the offer. Refresh and choose a smaller amount.`,
		);
	}
	return {
		ok: true,
		coverage: [
			{
				tokenId: offer.id,
				requestedAmount: offer.amount.toString(),
				validatedAmount: validatedAmount.toString(),
			},
		],
	};
}

async function validateFreshOffer(
	ctx: OneSatContext,
	offers: OfferedToken[],
): Promise<Bsv21OfferValidationResult> {
	if (!ctx.wallet) {
		return failure(
			"wallet-unavailable",
			"The active wallet is unavailable. Reconnect it before locking the offer.",
		);
	}
	if (!ctx.services?.bsv21) {
		return failure(
			"overlay-unavailable",
			"BSV21 verification is unavailable. Check the wallet connection and try again.",
		);
	}
	let outputs: WalletOutput[];
	try {
		outputs = await listBsv21.execute(ctx, { limit: 10_000 });
	} catch {
		return failure(
			"wallet-read-failed",
			"Could not refresh this wallet's BSV21 outputs. Reconnect or unlock the wallet and try again.",
		);
	}
	const candidates = collectCandidates(
		outputs,
		new Set(offers.map((offer) => offer.id)),
	);
	if (!candidates) {
		return failure(
			"overlay-mismatch",
			"The wallet returned conflicting BSV21 output data. Refresh the wallet before locking.",
		);
	}
	ctx.services.bsv21.clearCache();
	const results = await Promise.all(
		offers.map((offer) =>
			validateToken(ctx, offer, candidates.get(offer.id) ?? []),
		),
	);
	const failed = results.find((result) => !result.ok);
	if (failed) return failed;
	return {
		ok: true,
		coverage: results.flatMap((result) => (result.ok ? result.coverage : [])),
	};
}

/**
 * Performs a fresh, read-only pre-lock check of the value promised by a BSV21
 * offer. This is validation, not reservation: it does not create or sign an
 * action, and it deliberately returns no spendable outpoints for the offer.
 */
export async function validateBsv21OfferForLock(
	ctx: OneSatContext | null,
	items: readonly P2PTradeItem[],
	options: Bsv21OfferValidationOptions = {},
): Promise<Bsv21OfferValidationResult> {
	const offers = readOffers(items);
	if (!offers) {
		return failure(
			"invalid-offer",
			"The BSV21 offer data is invalid. Remove it and add the token again.",
		);
	}
	if (offers.length === 0) return { ok: true, coverage: [] };
	if (!ctx) {
		return failure(
			"wallet-unavailable",
			"The active wallet is unavailable. Reconnect it before locking the offer.",
		);
	}
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			validateFreshOffer(ctx, offers),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(
					() => reject(new ValidationTimeout("BSV21 validation timed out")),
					Math.max(1, timeoutMs),
				);
			}),
		]);
	} catch (error) {
		if (error instanceof ValidationTimeout) {
			return failure(
				"overlay-timeout",
				"BSV21 verification timed out. Check your connection and try locking again.",
			);
		}
		return failure(
			"overlay-unavailable",
			"BSV21 verification failed. Check your connection and try again.",
		);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
