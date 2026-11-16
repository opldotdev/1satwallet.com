/**
 * BRC-169 handles held by the wallet, and the `transaction-delivery` inbox at
 * each handle's messagebox. Port of Yours (1color branch)
 * `src/services/handles.ts`; the inbox is `@1sat/actions`
 * `syncTransactionInbox` (BRC-232 deliveries such as 1Color tokens, and
 * BRC-169 payments to a handle).
 */

import {
	type OneSatContext,
	type OverlayFor,
	type SyncTransactionInboxResult,
	syncTransactionInbox,
} from "@1sat/actions";
import { type HandleResolution, resolveHandle } from "@1sat/client";
import { HANDLE_CERT_TYPE } from "@1sat/types";
import { MasterCertificate, type WalletInterface } from "@bsv/sdk";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";

/** A BRC-169 handle certificate held in the wallet, with its fields decrypted. */
export interface HeldHandle {
	handle: string;
	domain: string;
	certifier: string;
	serialNumber: string;
}

/** `@handle@domain`, the form senders type and `resolveHandle` takes. */
export const formatHandle = (h: Pick<HeldHandle, "handle" | "domain">) =>
	`@${h.handle}@${h.domain}`;

/**
 * Messages already logged as waiting in a box, so one that stays there is
 * logged once, not every run. Its own set, capped: past the cap the oldest
 * is forgotten.
 */
const loggedWaiting = new Set<string>();
const LOGGED_WAITING_CAP = 500;

function firstTimeWaiting(key: string): boolean {
	if (loggedWaiting.has(key)) return false;
	if (loggedWaiting.size >= LOGGED_WAITING_CAP) {
		const oldest = loggedWaiting.values().next();
		if (!oldest.done) loggedWaiting.delete(oldest.value);
	}
	loggedWaiting.add(key);
	return true;
}

function logFailure(
	operation: string,
	detail: Record<string, unknown>,
	error: unknown,
): void {
	reportDiagnostic({
		category: "action",
		code: "action.failed",
		operation: `wallet.handles.${operation}`,
		recoverable: true,
	});
	console.error(`[handles] ${operation} failed`, { ...detail, error });
}

/**
 * The BRC-169 handle certificates the wallet holds, with `handle` and
 * `domain` decrypted (BRC-52). `listCertificates` returns the master keyring
 * the certifier encrypted for this wallet, so the wallet decrypts it with the
 * certifier as counterparty. A certificate whose fields can't be decrypted is
 * logged and left out.
 */
export async function listHandles(
	wallet: Pick<WalletInterface, "listCertificates" | "decrypt">,
): Promise<HeldHandle[]> {
	const { certificates } = await wallet.listCertificates({
		types: [HANDLE_CERT_TYPE],
		certifiers: [],
	});
	const handles: HeldHandle[] = [];
	for (const cert of certificates) {
		try {
			const fields = await MasterCertificate.decryptFields(
				wallet as WalletInterface,
				cert.keyring ?? {},
				cert.fields,
				cert.certifier,
			);
			if (!fields.handle || !fields.domain) {
				throw new Error("The certificate has no handle or domain field");
			}
			handles.push({
				handle: fields.handle,
				domain: fields.domain,
				certifier: cert.certifier,
				serialNumber: cert.serialNumber,
			});
		} catch (error) {
			logFailure(
				"decrypt-certificate",
				{ serialNumber: cert.serialNumber, certifier: cert.certifier },
				error,
			);
		}
	}
	return handles;
}

/** What one inbox run did, as the sync coordinator counts it. */
export interface HandleInboxSyncResult {
	/** Messages internalized and acknowledged. */
	processed: number;
	/** Handles not resolved, boxes not read, acknowledgements refused. */
	failed: number;
	/**
	 * Messages left in a box (the SDK's `skipped`): logged once each, never a
	 * task failure, since a message the wallet can't take stays until removed.
	 */
	waiting: number;
	/** 1Color assets received this run. */
	assetIds: string[];
}

type InboxSync = (
	ctx: OneSatContext,
	input: { messageboxUrl: string; overlayFor?: OverlayFor },
) => Promise<SyncTransactionInboxResult>;

export interface HandleInboxSyncOptions {
	/**
	 * The 1Color overlay for one asset, which its receipts are submitted to
	 * before they are internalized. Without it (mainnet) 1Color deliveries stay
	 * in the box with `overlay-required`; handle payments are still taken.
	 */
	overlayFor?: OverlayFor;
	/** For tests: stand-ins for the listing, BRC-169 resolution and the inbox action. */
	listHandles?: (wallet: OneSatContext["wallet"]) => Promise<HeldHandle[]>;
	resolveHandle?: (handle: string) => Promise<HandleResolution>;
	syncInbox?: InboxSync;
	now?: () => number;
}

/** The SDK's reason for a 1Color delivery read without an overlay. */
export const OVERLAY_REQUIRED = "overlay-required";

/**
 * Collects the `transaction-delivery` box at the messagebox of every handle
 * the wallet holds, once per distinct messagebox. Each handle's resolution is
 * cached for its `ttl` seconds (BRC-169 §5.4; ttl 0 is never cached). A call
 * made while a run is in flight gets that run. A handle that doesn't resolve
 * or a box that can't be read is logged and counted; the others still run.
 * Listing the certificates failing throws, since then nothing ran.
 */
export function createHandleInboxSync(
	ctx: OneSatContext,
	opts: HandleInboxSyncOptions = {},
): () => Promise<HandleInboxSyncResult> {
	const list = opts.listHandles ?? listHandles;
	const resolve = opts.resolveHandle ?? ((handle) => resolveHandle(handle));
	const sync: InboxSync =
		opts.syncInbox ?? ((c, input) => syncTransactionInbox.execute(c, input));
	const now = opts.now ?? Date.now;
	const cache = new Map<
		string,
		{ resolution: HandleResolution; expiresAt: number }
	>();
	let running: Promise<HandleInboxSyncResult> | null = null;

	const resolveOwn = async (handle: string) => {
		const cached = cache.get(handle);
		if (cached && now() < cached.expiresAt) return cached.resolution;
		cache.delete(handle);
		const resolution = await resolve(handle);
		if (resolution.ttl > 0) {
			cache.set(handle, {
				resolution,
				expiresAt: now() + resolution.ttl * 1000,
			});
		}
		return resolution;
	};

	const run = async (): Promise<HandleInboxSyncResult> => {
		let held: HeldHandle[];
		try {
			held = await list(ctx.wallet);
		} catch (error) {
			throw new Error("Listing the wallet's handle certificates failed", {
				cause: error,
			});
		}
		const result: HandleInboxSyncResult = {
			processed: 0,
			failed: 0,
			waiting: 0,
			assetIds: [],
		};

		const messageboxes = new Set<string>();
		for (const handle of new Set(held.map(formatHandle))) {
			try {
				messageboxes.add((await resolveOwn(handle)).messagebox);
			} catch (error) {
				logFailure("resolve", { handle }, error);
				result.failed += 1;
			}
		}

		for (const messageboxUrl of messageboxes) {
			let synced: SyncTransactionInboxResult;
			try {
				synced = await sync(ctx, {
					messageboxUrl,
					...(opts.overlayFor ? { overlayFor: opts.overlayFor } : {}),
				});
			} catch (error) {
				logFailure("inbox", { messageboxUrl }, error);
				result.failed += 1;
				continue;
			}
			if (synced.error) {
				// A listing that failed, or acknowledgements refused after the
				// messages were taken (they merge and are acknowledged next run).
				logFailure(
					"inbox",
					{
						messageboxUrl,
						received: synced.received.length,
						skipped: synced.skipped.length,
					},
					new Error(synced.error),
				);
				result.failed += 1;
			}
			result.processed += synced.received.length;
			for (const receipt of synced.received) {
				result.assetIds.push(...receipt.assetIds);
			}
			for (const skip of synced.skipped) {
				result.waiting += 1;
				// A message waits in its box until it can be taken: logged once.
				if (!firstTimeWaiting(`${messageboxUrl}:${skip.messageId}`)) continue;
				if (!opts.overlayFor && skip.reason === OVERLAY_REQUIRED) {
					console.warn(
						"[handles] 1Color delivery left in the box: this chain has no 1Color overlay",
						{ messageboxUrl, messageId: skip.messageId },
					);
				} else {
					logFailure(
						"message",
						{ messageboxUrl, messageId: skip.messageId },
						new Error(skip.reason),
					);
				}
			}
		}
		result.assetIds = [...new Set(result.assetIds)];
		return result;
	};

	return () => {
		if (running) return running;
		const current = run().finally(() => {
			if (running === current) running = null;
		});
		running = current;
		return current;
	};
}
