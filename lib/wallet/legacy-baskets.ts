import { createContext, type OneSatContext } from "@1sat/actions";
import {
	BSOCIAL_BASKET,
	BSV20_BASKET,
	BSV21_BASKET,
	LOCK_BASKET,
	ONESAT_BASKET,
	OPNS_BASKET,
	SIGMA_BASKET,
} from "@1sat/types";
import {
	Beef,
	type ListOutputsArgs,
	type ListOutputsResult,
	type WalletInterface,
	type WalletOutput,
} from "@bsv/sdk";

/** Basket for hosted-content outputs; @1sat/types has no constant for it. */
export const HOSTING_BASKET = "hosting";

/**
 * Current basket → older basket names that may still hold its outputs.
 *
 * Older wallets filed assets under `p 1sat …` baskets (and theme-token used a
 * plain `ordinals` basket). Wallet-toolbox rejects a basket insertion for an
 * output that already has a basket, so nothing can move them through the
 * wallet interface, and the browser wallet's local store is not re-filed.
 * Readers therefore read each legacy name alongside the current one. Reads
 * only: outputs are never moved.
 */
export const LEGACY_BASKETS: Readonly<Record<string, readonly string[]>> = {
	[ONESAT_BASKET]: ["p 1sat ordinals", "ordinals"],
	[BSV21_BASKET]: ["p 1sat bsv21"],
	[OPNS_BASKET]: ["p 1sat opns"],
	[HOSTING_BASKET]: ["p 1sat hosting"],
	[LOCK_BASKET]: ["p 1sat lock"],
	[SIGMA_BASKET]: ["p 1sat sigma"],
	[BSOCIAL_BASKET]: ["p 1sat bsocial"],
	[BSV20_BASKET]: ["p 1sat bsv20"],
};

export function legacyBasketsFor(
	basket: string | undefined,
): readonly string[] {
	if (!basket || !Object.hasOwn(LEGACY_BASKETS, basket)) return [];
	return LEGACY_BASKETS[basket];
}

const DEFAULT_LIST_LIMIT = 10;

function mergeBeef(
	results: ListOutputsResult[],
): ListOutputsResult["BEEF"] | undefined {
	const parts = results.flatMap((result) =>
		result.BEEF?.length ? [result.BEEF] : [],
	);
	if (parts.length <= 1) return parts[0];
	const beef = new Beef();
	for (const part of parts) beef.mergeBeef(Array.from(part));
	const bytes = beef.toBinary();
	return (
		parts[0] instanceof Uint8Array ? Uint8Array.from(bytes) : bytes
	) as ListOutputsResult["BEEF"];
}

function dedupeByOutpoint(outputs: WalletOutput[]): WalletOutput[] {
	const seen = new Set<string>();
	return outputs.filter((output) => {
		if (seen.has(output.outpoint)) return false;
		seen.add(output.outpoint);
		return true;
	});
}

/**
 * `listOutputs` over a current basket and its legacy names, paged as one
 * list: the current basket first, then each legacy basket in table order.
 * `totalOutputs` is the sum across them. A failed legacy read fails the call,
 * so a balance never silently understates. A negative offset reads the
 * current basket only. Any other basket passes straight through.
 */
export async function listOutputsWithLegacy(
	wallet: WalletInterface,
	args: ListOutputsArgs,
	originator?: string,
): Promise<ListOutputsResult> {
	const legacy = legacyBasketsFor(args.basket);
	const current = await wallet.listOutputs(args, originator);
	const offset = args.offset ?? 0;
	// A negative (newest-first) offset reads the current basket only.
	if (legacy.length === 0 || offset < 0) return current;

	const limit = args.limit ?? DEFAULT_LIST_LIMIT;
	let skip = Math.max(0, offset - Number(current.totalOutputs));
	let need = limit - current.outputs.length;
	let totalOutputs = Number(current.totalOutputs);
	const outputs = [...current.outputs];
	const withOutputs: ListOutputsResult[] = [current];

	for (const basket of legacy) {
		const result = await wallet.listOutputs(
			need > 0
				? { ...args, basket, offset: skip, limit: need }
				: { ...args, basket, include: undefined, offset: 0, limit: 1 },
			originator,
		);
		const count = Number(result.totalOutputs);
		totalOutputs += count;
		if (need <= 0) continue;
		outputs.push(...result.outputs);
		if (result.outputs.length > 0) withOutputs.push(result);
		need -= result.outputs.length;
		skip = Math.max(0, skip - count);
	}

	const merged = dedupeByOutpoint(outputs).slice(0, limit);
	const beef = mergeBeef(withOutputs);
	return {
		...current,
		totalOutputs,
		outputs: merged,
		...(beef ? { BEEF: beef } : {}),
	};
}

const legacyAware = Symbol("legacyBasketReads");

/**
 * The same wallet, with `listOutputs` reading each current basket's legacy
 * names too. Every other method is the wallet's own.
 */
export function withLegacyBasketReads(
	wallet: WalletInterface,
): WalletInterface {
	if ((wallet as { [legacyAware]?: true })[legacyAware]) return wallet;
	const listOutputs: WalletInterface["listOutputs"] = (args, originator) =>
		listOutputsWithLegacy(wallet, args, originator);
	return new Proxy(wallet, {
		get(target, property) {
			if (property === legacyAware) return true;
			if (property === "listOutputs") return listOutputs;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/**
 * OneSat action context for the website's own wallet. The built-in browser
 * wallet reads legacy basket names; other wallets re-file or never had them.
 */
export function createWalletContext(
	wallet: WalletInterface,
	options: Parameters<typeof createContext>[1] & { builtIn: boolean },
): OneSatContext {
	const { builtIn, ...contextOptions } = options;
	return createContext(
		builtIn ? withLegacyBasketReads(wallet) : wallet,
		contextOptions,
	);
}
