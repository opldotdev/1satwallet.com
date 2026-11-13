import {
	BSOCIAL_BASKET,
	BSV21_BASKET,
	LOCK_BASKET,
	ONESAT_BASKET,
	OPNS_BASKET,
	SIGMA_BASKET,
} from "@1sat/types";
import { Beef, type WalletInterface } from "@bsv/sdk";

/** Leftover theme-token basket. */
export const LEFTOVER_ORDINALS_BASKET = "ordinals";

export type BasketMigration = { from: string; to: string };

/**
 * Legacy `p 1sat …` baskets and the plain baskets that replace them. The
 * @1sat packages dropped this table and `moveBasketOutputs` in
 * @1sat/actions 0.0.228, so the website owns the one-time move for wallets
 * that still hold outputs in the old baskets. The rows (and their order)
 * must stay as published so `mappingVersion` keeps matching wallets that
 * already completed the move.
 */
export const LEGACY_P1SAT_BASKET_MIGRATIONS: readonly BasketMigration[] = [
	{ from: "p 1sat ordinals", to: ONESAT_BASKET },
	{ from: LEFTOVER_ORDINALS_BASKET, to: ONESAT_BASKET },
	{ from: "p 1sat bsv21", to: BSV21_BASKET },
	{ from: "p 1sat opns", to: OPNS_BASKET },
	{ from: "p 1sat lock", to: LOCK_BASKET },
	{ from: "p 1sat sigma", to: SIGMA_BASKET },
	{ from: "p 1sat bsocial", to: BSOCIAL_BASKET },
];

export type MoveBasketResult = {
	from: string;
	to: string;
	moved: number;
	skipped: number;
	outpoints: string[];
	errors: Array<{ outpoint: string; error: string }>;
};

/**
 * Re-file spendable outputs from one basket into another with
 * `internalizeAction` basket insertion, keeping tags and custom
 * instructions. Nothing is spent on chain. Each outpoint is internalized with
 * an AtomicBEEF for its own transaction.
 */
export async function moveBasketOutputs(
	wallet: WalletInterface,
	fromBasket: string,
	toBasket: string,
	opts: { limit?: number; offset?: number } = {},
): Promise<MoveBasketResult> {
	const from = fromBasket.trim();
	const to = toBasket.trim();
	if (!from || !to) throw new Error("moveBasket: from and to baskets required");
	const result: MoveBasketResult = {
		from,
		to,
		moved: 0,
		skipped: 0,
		outpoints: [],
		errors: [],
	};
	if (from === to) return result;

	const listed = await wallet.listOutputs({
		basket: from,
		include: "entire transactions",
		includeTags: true,
		includeCustomInstructions: true,
		limit: opts.limit ?? 1000,
		offset: opts.offset ?? 0,
	});
	if (!listed.BEEF?.length && listed.outputs.length > 0) {
		throw new Error(
			`moveBasket: listOutputs returned no BEEF for basket ${from}`,
		);
	}
	const beef = listed.BEEF?.length
		? Beef.fromBinary(Array.from(listed.BEEF))
		: null;
	const skip = (outpoint: string, error: string) => {
		result.skipped++;
		result.errors.push({ outpoint, error });
	};

	for (const output of listed.outputs) {
		const outpoint = output.outpoint;
		const [txid, voutText] = outpoint?.split(".") ?? [];
		const vout = Number(voutText);
		if (!txid || voutText === undefined || !Number.isInteger(vout)) {
			skip(outpoint ?? "?", "bad-outpoint");
			continue;
		}
		if (!beef) {
			skip(outpoint, "no-beef");
			continue;
		}
		let atomic: number[];
		try {
			if (!beef.findTxid(txid)) {
				skip(outpoint, `beef-missing-txid:${txid.slice(0, 12)}`);
				continue;
			}
			atomic = Array.from(beef.toBinaryAtomic(txid));
		} catch (error) {
			skip(
				outpoint,
				error instanceof Error ? error.message : "atomic-beef-failed",
			);
			continue;
		}
		try {
			await wallet.internalizeAction({
				tx: atomic,
				outputs: [
					{
						outputIndex: vout,
						protocol: "basket insertion",
						insertionRemittance: {
							basket: to,
							tags: output.tags ?? [],
							customInstructions: output.customInstructions,
						},
					},
				],
				description: `move basket ${from} → ${to}`,
			});
			result.moved++;
			result.outpoints.push(outpoint);
		} catch (error) {
			skip(outpoint, error instanceof Error ? error.message : String(error));
		}
	}
	return result;
}

export type BasketMigrateStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
};

export type MoveBasketFn = (
	wallet: WalletInterface,
	fromBasket: string,
	toBasket: string,
) => Promise<MoveBasketResult>;

export function legacyBasketMigrations(
	published: readonly BasketMigration[] = LEGACY_P1SAT_BASKET_MIGRATIONS,
): BasketMigration[] {
	const leftover: BasketMigration = {
		from: LEFTOVER_ORDINALS_BASKET,
		to: ONESAT_BASKET,
	};
	const rows = published.some(
		(row) => row.from === leftover.from && row.to === leftover.to,
	)
		? [...published]
		: [...published, leftover];
	const seen = new Set<string>();
	return rows.filter((row) => {
		const key = `${row.from}>${row.to}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function mappingVersion(
	migrations: readonly BasketMigration[] = legacyBasketMigrations(),
): string {
	return migrations
		.map((row) => `${row.from}>${row.to}`)
		.sort()
		.join("\n");
}

export function defaultsKey(
	identityHex: string,
	version: string = mappingVersion(),
): string {
	return `legacyP1SatBasketsMigrated.${version}.${identityHex}`;
}

export function isDue(
	identityHex: string,
	storage: BasketMigrateStorage,
	version: string = mappingVersion(),
): boolean {
	return storage.getItem(defaultsKey(identityHex, version)) !== "1";
}

function isComplete(result: MoveBasketResult): boolean {
	return result.errors.length === 0 && result.skipped === 0;
}

function failedMove(from: string, to: string, error: string): MoveBasketResult {
	return {
		from,
		to,
		moved: 0,
		skipped: 1,
		outpoints: [],
		errors: [{ outpoint: "?", error }],
	};
}

export async function migrateLegacyBaskets(
	wallet: WalletInterface,
	options: {
		move?: MoveBasketFn;
		migrations?: readonly BasketMigration[];
	} = {},
): Promise<{
	results: MoveBasketResult[];
	totalMoved: number;
	complete: boolean;
}> {
	const move = options.move ?? moveBasketOutputs;
	const migrations = options.migrations ?? legacyBasketMigrations();
	const results: MoveBasketResult[] = [];
	let totalMoved = 0;
	for (const { from, to } of migrations) {
		let result: MoveBasketResult;
		try {
			result = await move(wallet, from, to);
		} catch (error) {
			result = failedMove(
				from,
				to,
				error instanceof Error ? error.message : String(error),
			);
		}
		results.push(result);
		totalMoved += result.moved;
	}
	return {
		results,
		totalMoved,
		complete: results.every(isComplete),
	};
}

export async function migrateIfNeeded(input: {
	wallet: WalletInterface;
	identityHex: string;
	storage: BasketMigrateStorage;
	move?: MoveBasketFn;
}): Promise<{ ran: boolean; totalMoved: number; complete: boolean }> {
	const version = mappingVersion();
	if (!isDue(input.identityHex, input.storage, version)) {
		return { ran: false, totalMoved: 0, complete: true };
	}
	const result = await migrateLegacyBaskets(input.wallet, { move: input.move });
	if (result.complete) {
		input.storage.setItem(defaultsKey(input.identityHex, version), "1");
	}
	return {
		ran: true,
		totalMoved: result.totalMoved,
		complete: result.complete,
	};
}
