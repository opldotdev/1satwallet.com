import type { OneSatContext } from "@1sat/actions";
import type { OneSatServices } from "@1sat/client";
import { wifToHex } from "@1sat/utils";
import { PrivateKey, type WalletInterface } from "@bsv/sdk";
import type { SweepResult } from "@/lib/sweep-migration";
import {
	cancelListedAssets,
	type ListedAsset,
} from "@/lib/wallet/migration-listings";
import {
	PayKeyTransferIncompleteError,
	type PayKeyTransferResult,
	transferPayKeyWallet,
} from "@/lib/wallet/pay-key-transfer";

/** A live BRC-100 wallet a migration step runs against. */
export interface MigrationTarget {
	wallet: WalletInterface;
	services: OneSatServices;
	oneSatContext: OneSatContext;
}

type CancelListings = typeof cancelListedAssets;

/**
 * The wallet the provider is running now. Throws instead of skipping a step
 * when any part is missing.
 */
export function requireMigrationTarget(current: {
	wallet: WalletInterface | null;
	services: OneSatServices | null;
	oneSatContext: OneSatContext | null;
}): MigrationTarget {
	if (!current.wallet || !current.services || !current.oneSatContext) {
		throw new Error(
			"BRC-100 wallet is not initialized — unlock your wallet and try again",
		);
	}
	return {
		wallet: current.wallet,
		services: current.services,
		oneSatContext: current.oneSatContext,
	};
}

/**
 * Some listings were not cancelled. The message names each failure and the
 * cancels that did go through; `cancelTxids` carries those txids.
 */
export class ListingCancelError extends Error {
	readonly cancelTxids: string[];
	readonly errors: string[];
	constructor(total: number, cancelTxids: string[], errors: string[]) {
		const done =
			cancelTxids.length > 0
				? ` Cancelled ${cancelTxids.length}: ${cancelTxids.join(", ")}.`
				: "";
		super(
			`Listings must be cancelled before migration can finish. ${errors.length} of ${total} not cancelled: ${errors.join("; ")}.${done}`,
		);
		this.name = "ListingCancelError";
		this.cancelTxids = cancelTxids;
		this.errors = errors;
	}
}

/**
 * Cancel the wallet's own listings on `ctx`. A listing left open blocks the
 * migration with a ListingCancelError.
 */
export async function cancelWalletListings(
	ctx: OneSatContext,
	listings: ListedAsset[],
	cancel: CancelListings = cancelListedAssets,
): Promise<string[]> {
	if (listings.length === 0) return [];
	const cancelled = await cancel(ctx, listings);
	if (!cancelled.ok) {
		console.error("[migration] listing cancel failed", cancelled.errors);
		throw new ListingCancelError(
			listings.length,
			cancelled.txids,
			cancelled.errors,
		);
	}
	return cancelled.txids;
}

/** What a failed run already did on chain, for the result rows. */
export function partialRunResult(
	error: unknown,
): { cancelTxids: string[]; transferTxids: string[]; errors: string[] } | null {
	if (error instanceof ListingCancelError) {
		return {
			cancelTxids: error.cancelTxids,
			transferTxids: [],
			errors: error.errors,
		};
	}
	if (error instanceof PayKeyTransferIncompleteError) {
		return {
			cancelTxids: error.cancelTxids,
			transferTxids: error.transferTxids,
			errors: error.errors,
		};
	}
	return null;
}

export interface ReRootDeps {
	identityWif: string;
	isInitialized: boolean;
	destroyWallet: () => Promise<void>;
	initializeWallet: (rootKeyHex: string) => Promise<MigrationTarget | null>;
	/** Pause between teardown and init; tests pass 0. */
	settleMs?: number;
}

/**
 * Re-root the built-in wallet at the identity key and return the NEW wallet.
 * The provider's context value captured before the re-root still points at
 * the destroyed pay-key wallet, so every later step must use this return
 * value. Throws when init fails or the new wallet is not rooted at the
 * identity key.
 */
export async function reRootWallet(deps: ReRootDeps): Promise<MigrationTarget> {
	if (deps.isInitialized) await deps.destroyWallet();
	const settleMs = deps.settleMs ?? 500;
	if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));

	const target = await deps.initializeWallet(wifToHex(deps.identityWif));
	if (!target) {
		throw new Error("Failed to initialize wallet with identity key");
	}
	const expected = PrivateKey.fromWif(deps.identityWif)
		.toPublicKey()
		.toString();
	const { publicKey } = await target.wallet.getPublicKey({
		identityKey: true,
	});
	if (publicKey !== expected) {
		throw new Error(
			"The reinitialized wallet is not rooted at the identity key; nothing was swept.",
		);
	}
	return target;
}

export type FirstRunStage =
	| "cancel"
	| "transfer"
	| "persist"
	| "reroot"
	| "sweep";

type TransferPayKeyWallet = (
	ctx: OneSatContext,
	identityWif: string,
) => Promise<PayKeyTransferResult>;

export interface FirstRunMigrationDeps extends ReRootDeps {
	/** The wallet running now (pay-key rooted); it owns `listings`. */
	current: Parameters<typeof requireMigrationTarget>[0];
	listings: ListedAsset[];
	cancelListings?: CancelListings;
	/** Move everything the pay-key wallet holds to the identity root. */
	transferPayKeyWallet?: TransferPayKeyWallet;
	/** Save the keys with the identity key added; throws on failure. */
	persistIdentity: () => Promise<void>;
	/** Sweep into the re-rooted wallet; null when nothing is selected. */
	sweep: (target: MigrationTarget) => Promise<SweepResult | null>;
	onStage?: (stage: FirstRunStage) => void;
}

export interface MigrationRun {
	cancelTxids: string[];
	/** Moves from the pay-key wallet to the identity root (first run only). */
	transferTxids: string[];
	sweep: SweepResult | null;
}

/**
 * First migration of an original 1Sat wallet:
 * 1. cancel the wallet's own listings on the wallet that holds them (the
 *    running pay-key wallet), before anything changes;
 * 2. move everything that wallet holds (BSV, ordinals, BSV-21, BSV-20, the
 *    items step 1 returned) to the identity root's deposit address, which the
 *    identity wallet syncs. Wallet storage is per identity key, so anything
 *    left would be hidden after step 4: if anything is left, this throws and
 *    nothing below runs;
 * 3. save the keys with the identity key;
 * 4. re-root the BRC-100 wallet at the identity key;
 * 5. sweep the legacy addresses into the wallet step 4 returned.
 */
export async function runFirstRunMigration(
	deps: FirstRunMigrationDeps,
): Promise<MigrationRun> {
	const current = requireMigrationTarget(deps.current);
	let cancelTxids: string[] = [];
	if (deps.listings.length > 0) {
		deps.onStage?.("cancel");
		cancelTxids = await cancelWalletListings(
			current.oneSatContext,
			deps.listings,
			deps.cancelListings,
		);
	}

	let transferTxids: string[] = [];
	const identityPubKey = PrivateKey.fromWif(deps.identityWif)
		.toPublicKey()
		.toString();
	const { publicKey: currentRoot } = await current.wallet.getPublicKey({
		identityKey: true,
	});
	// A wallet already rooted at the identity key holds nothing to move.
	if (currentRoot !== identityPubKey) {
		deps.onStage?.("transfer");
		const transfer = deps.transferPayKeyWallet ?? transferPayKeyWallet;
		try {
			transferTxids = (await transfer(current.oneSatContext, deps.identityWif))
				.txids;
		} catch (error) {
			if (error instanceof PayKeyTransferIncompleteError) {
				// Cancels that went through still count in the result.
				error.cancelTxids = cancelTxids;
			}
			throw error;
		}
	}

	deps.onStage?.("persist");
	try {
		await deps.persistIdentity();
	} catch (error) {
		if (transferTxids.length === 0) throw error;
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(
			`${reason} This wallet's assets were already moved to your identity key's deposit address (${transferTxids.join(", ")}); they show up once the migration finishes, so run it again.`,
			{ cause: error },
		);
	}

	deps.onStage?.("reroot");
	const target = await reRootWallet(deps);

	deps.onStage?.("sweep");
	return { cancelTxids, transferTxids, sweep: await deps.sweep(target) };
}

/**
 * Sweep-only re-entry for a wallet that is already identity-rooted: cancel
 * and sweep on the wallet running now.
 */
export async function runMigrationOnTarget(
	target: MigrationTarget,
	deps: {
		listings: ListedAsset[];
		cancelListings?: CancelListings;
		sweep: (target: MigrationTarget) => Promise<SweepResult | null>;
		onStage?: (stage: "cancel" | "sweep") => void;
	},
): Promise<MigrationRun> {
	let cancelTxids: string[] = [];
	if (deps.listings.length > 0) {
		deps.onStage?.("cancel");
		cancelTxids = await cancelWalletListings(
			target.oneSatContext,
			deps.listings,
			deps.cancelListings,
		);
	}
	deps.onStage?.("sweep");
	return { cancelTxids, transferTxids: [], sweep: await deps.sweep(target) };
}
