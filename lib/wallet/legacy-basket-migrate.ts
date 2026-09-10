import { type MoveBasketResult, moveBasketOutputs } from "@1sat/actions";
import { LEGACY_P1SAT_BASKET_MIGRATIONS, ONESAT_BASKET } from "@1sat/types";
import type { WalletInterface } from "@bsv/sdk";

/** Leftover theme-token basket. Also listed in @1sat/types 0.0.42. */
export const LEFTOVER_ORDINALS_BASKET = "ordinals";

export type BasketMigration = { from: string; to: string };

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
