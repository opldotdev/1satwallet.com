import type { OneSatContext } from "@1sat/actions";
import type { OneSatServices } from "@1sat/client";
import { wifToHex } from "@1sat/utils";
import { PrivateKey, type WalletInterface } from "@bsv/sdk";
import type { SweepResult } from "@/lib/sweep-migration";
import {
	cancelListedAssets,
	type ListedAsset,
} from "@/lib/wallet/migration-listings";

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
 * Cancel the wallet's own listings on `ctx`. A listing left open blocks the
 * migration; its per-listing errors travel as the thrown error's cause.
 */
export async function cancelWalletListings(
	ctx: OneSatContext,
	listings: ListedAsset[],
	cancel: CancelListings = cancelListedAssets,
): Promise<string[]> {
	if (listings.length === 0) return [];
	const cancelled = await cancel(ctx, listings);
	if (!cancelled.ok) {
		throw new Error("Listings must be cancelled before migration can finish.", {
			cause: cancelled.errors,
		});
	}
	return cancelled.txids;
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

export type FirstRunStage = "cancel" | "persist" | "reroot" | "sweep";

export interface FirstRunMigrationDeps extends ReRootDeps {
	/** The wallet running now (pay-key rooted); it owns `listings`. */
	current: Parameters<typeof requireMigrationTarget>[0];
	listings: ListedAsset[];
	cancelListings?: CancelListings;
	/** Save the keys with the identity key added; throws on failure. */
	persistIdentity: () => Promise<void>;
	/** Sweep into the re-rooted wallet; null when nothing is selected. */
	sweep: (target: MigrationTarget) => Promise<SweepResult | null>;
	onStage?: (stage: FirstRunStage) => void;
}

export interface MigrationRun {
	cancelTxids: string[];
	sweep: SweepResult | null;
}

/**
 * First migration of an original 1Sat wallet:
 * 1. cancel the wallet's own listings on the wallet that holds them (the
 *    running pay-key wallet), before anything changes;
 * 2. save the keys with the identity key;
 * 3. re-root the BRC-100 wallet at the identity key;
 * 4. sweep the legacy addresses into the wallet step 3 returned.
 */
export async function runFirstRunMigration(
	deps: FirstRunMigrationDeps,
): Promise<MigrationRun> {
	let cancelTxids: string[] = [];
	if (deps.listings.length > 0) {
		deps.onStage?.("cancel");
		const current = requireMigrationTarget(deps.current);
		cancelTxids = await cancelWalletListings(
			current.oneSatContext,
			deps.listings,
			deps.cancelListings,
		);
	}

	deps.onStage?.("persist");
	await deps.persistIdentity();

	deps.onStage?.("reroot");
	const target = await reRootWallet(deps);

	deps.onStage?.("sweep");
	return { cancelTxids, sweep: await deps.sweep(target) };
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
	return { cancelTxids, sweep: await deps.sweep(target) };
}
