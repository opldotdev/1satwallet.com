import {
	internalizeBeef,
	type OneSatContext,
	type OutputDerivation,
	type ProcessedTxStore,
	ProcessedTxStoreIdb,
	sweepDeposit,
} from "@1sat/actions";
import { type AddressManager, BRC29_PROTOCOL_ID } from "@1sat/wallet-browser";
import { PublicKey } from "@bsv/sdk";
import { errorNameOf, reportDiagnostic } from "@/lib/runtime-diagnostics";

/*
 * The built-in wallet shows BRC-29 self-derived addresses as Receive
 * (`lib/receive-address-manager.ts`), while `syncAddresses` only scans the
 * `[0,'onesat']` / `[0,'p 1sat']` "1sat N" sets. This task scans every
 * address the address manager holds, the way `syncAddresses` scans its own,
 * and internalizes what it finds under the BRC-29 derivation the address was
 * made with, so the wallet can spend it. It adds to `syncAddresses`; it keeps
 * its own processed-tx store and cursor.
 */

/** Same reorg window as `syncAddresses`. */
const REORG_SAFE_DEPTH = 6;

/**
 * The score cursor only holds for addresses that were scanned up to it. The
 * store records each such address as `covered:<address>` beside the txids
 * (never a 64-hex txid, so the two cannot collide). An address the manager
 * gains later is scanned from the start once, then joins the cursor.
 */
const coveredKey = (address: string) => `covered:${address}`;

export interface ReceiveAddressSyncResult {
	processed: number;
	failed: number;
}

/**
 * Its own store, per chain and identity. `syncAddresses` keys its store (and
 * its score cursor) by the identity key alone, under `sync-processed-<key>`;
 * this one is `sync-processed-brc29-receive-<chain>-<key>`, so neither moves
 * the other's cursor.
 */
export function receiveAddressStoreNamespace(
	chain: "main" | "test",
	identityKey: string,
): string {
	return `brc29-receive-${chain}-${identityKey}`;
}

export function openReceiveAddressStore(
	chain: "main" | "test",
	identityKey: string,
): ProcessedTxStore {
	if (typeof indexedDB === "undefined") {
		throw new Error("Receive address sync needs IndexedDB");
	}
	return new ProcessedTxStoreIdb(
		receiveAddressStoreNamespace(chain, identityKey),
	);
}

/**
 * The address manager's own derivations, keyed by address on `chain`. The
 * keyID is the one the address was derived with:
 * `<derivationPrefix> <derivationSuffix>` under BRC-29, forSelf.
 */
export function receiveAddressDerivations(
	addressManager: AddressManager,
	chain: "main" | "test",
): Map<string, OutputDerivation> {
	const derivations = new Map<string, OutputDerivation>();
	for (const shown of addressManager.getAddresses()) {
		const derivation = addressManager.getDerivation(shown);
		if (!derivation) continue;
		const address = PublicKey.fromString(derivation.publicKey).toAddress(chain);
		derivations.set(address, {
			outputIndex: 0, // unused in address mode
			keyID: `${derivation.derivationPrefix} ${derivation.derivationSuffix}`,
			derivationPrefix: derivation.derivationPrefix,
			derivationSuffix: derivation.derivationSuffix,
			senderIdentityKey: derivation.senderIdentityKey,
			protocolID: BRC29_PROTOCOL_ID,
			counterparty: "self",
		});
	}
	return derivations;
}

function reportFailure(operation: string, error: unknown) {
	// Full detail for debugging; the diagnostic carries only the error name.
	console.error(`[sync] ${operation} failed`, error);
	reportDiagnostic({
		category: "provider",
		code: "provider.failed",
		operation,
		recoverable: true,
		context: { retryable: true, errorName: errorNameOf(error) },
	});
}

/**
 * Fetches outputs at the Receive addresses as `syncAddresses` does (owner
 * sync from the 1sat-stack indexer, BEEF per txid, a reorg-safe score cursor
 * that holds back on any failure) and internalizes them with the SDK's
 * `internalizeBeef`: plain BSV lands in the deposit basket and is swept into
 * funding; ordinals and BSV-21 land in their baskets with the BRC-29
 * protocolID and keyID in their custom instructions.
 */
export async function syncReceiveAddresses(
	ctx: OneSatContext,
	addressManager: AddressManager,
	store: ProcessedTxStore,
): Promise<ReceiveAddressSyncResult> {
	try {
		const services = ctx.services;
		if (!services) throw new Error("Receive address sync needs services");
		const addressDerivations = receiveAddressDerivations(
			addressManager,
			ctx.chain,
		);
		if (addressDerivations.size === 0) return { processed: 0, failed: 0 };

		const { height } = await ctx.wallet.getHeight({});
		const lastScore = await store.getLastScore();
		const covered: string[] = [];
		const uncovered: string[] = [];
		for (const address of addressDerivations.keys()) {
			if (await store.has(coveredKey(address))) covered.push(address);
			else uncovered.push(address);
		}
		const outputsByTxid = new Map<string, { spendTxid?: string }[]>();
		let maxSafeScore = lastScore;
		// Covered addresses from the cursor; new ones from the start.
		const scans: [string[], number | undefined][] = [
			[covered, lastScore || undefined],
			[uncovered, undefined],
		];
		for (const [addresses, from] of scans) {
			if (addresses.length === 0) continue;
			for await (const output of services.owner.sync(addresses, from)) {
				const txid = output.outpoint.substring(0, 64);
				const outputs = outputsByTxid.get(txid) ?? [];
				outputs.push(output);
				outputsByTxid.set(txid, outputs);
				if (
					height - Math.floor(output.score) >= REORG_SAFE_DEPTH &&
					output.score > maxSafeScore
				) {
					maxSafeScore = output.score;
				}
			}
		}

		let processed = 0;
		let failed = 0;
		for (const [txid, outputs] of outputsByTxid) {
			if (await store.has(txid)) continue;
			try {
				// Every output already spent: nothing left to own.
				if (!outputs.every((output) => !!output.spendTxid)) {
					const beef = await services.beef.getBeef(txid);
					if (!beef) throw new Error("BEEF not found");
					await internalizeBeef({
						beef,
						addressDerivations,
						wallet: ctx.wallet,
						services,
						chain: ctx.chain,
					});
				}
				await store.add(txid);
				processed++;
			} catch (error) {
				reportFailure("wallet.sync.receiveAddresses.internalize", error);
				failed++;
			}
		}

		// The cursor is the only record of what is left: advance it only when
		// nothing failed, as `syncAddresses` does.
		// New addresses join the cursor only on a clean run, like the cursor.
		if (failed === 0) {
			if (maxSafeScore > lastScore) await store.setLastScore(maxSafeScore);
			for (const address of uncovered) await store.add(coveredKey(address));
		}

		// Plain BSV waits in the deposit basket; move it into funding, every
		// run, as `syncAddresses` does. A failure loses nothing (the deposit
		// stays in the basket and the next sweep retries) but shows as a
		// failed item.
		try {
			await sweepDeposit.execute(ctx, {});
		} catch (error) {
			reportFailure("wallet.sync.receiveAddresses.sweep", error);
			failed++;
		}

		return { processed, failed };
	} finally {
		await store.close();
	}
}
