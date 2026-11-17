"use client";

import type { OneSatContext } from "@1sat/actions";
import {
	createContext as createActionContext,
	syncAddresses,
	syncCosignDeliveries,
	syncMessages,
} from "@1sat/actions";
import type { AddressManager, OneSatServices } from "@1sat/wallet-browser";
import type { WalletInterface } from "@bsv/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { endpointsOf, isOneColorAvailable } from "@/lib/chain-endpoints";
import { RECEIVE_ADDRESS_PREFIX } from "@/lib/receive-address-manager";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import type { ColorOverlayResolver } from "@/lib/wallet/color-overlay";
import { createHandleInboxSync } from "@/lib/wallet/handles";
import {
	combineInboxResults,
	paymailSyncFailed,
	syncAccountPeerPayInbox,
} from "@/lib/wallet/peerpay-inbox";
import {
	openReceiveAddressStore,
	syncReceiveAddresses,
} from "@/lib/wallet/receive-address-sync";

export type SyncTaskName =
	| "addresses"
	| "receiveAddresses"
	| "payments"
	| "cosignDeliveries"
	| "handleInbox";
export type SyncTaskStatus =
	| "idle"
	| "running"
	| "succeeded"
	| "failed"
	| "provider-managed";

export interface SyncTaskState {
	status: SyncTaskStatus;
	lastRunAt: number | null;
	processed: number | null;
	failed: number | null;
	error: string | null;
}

export type SyncTasksState = Record<SyncTaskName, SyncTaskState>;

interface SyncTaskResult {
	processed: number;
	failed: number;
}

type SyncJob = () => Promise<SyncTaskResult>;

/** The Receive address task is optional; a run given no job for it skips it. */
type SyncJobs = Record<Exclude<SyncTaskName, "receiveAddresses">, SyncJob> & {
	receiveAddresses?: SyncJob;
};

const TASK_NAMES: readonly SyncTaskName[] = [
	"addresses",
	"payments",
	"cosignDeliveries",
	"handleInbox",
	"receiveAddresses",
];

/** What the handle inbox timer runs between full syncs. */
const HANDLE_INBOX_ONLY: readonly SyncTaskName[] = ["handleInbox"];

/** How often the handle inboxes are collected while the page is visible (Yours `HANDLE_INBOX_SYNC_INTERVAL_MS`). */
export const HANDLE_INBOX_SYNC_INTERVAL_MS = 60_000;

export function createSyncTasksState(
	status: SyncTaskStatus = "idle",
): SyncTasksState {
	return Object.fromEntries(
		TASK_NAMES.map((name) => [
			name,
			{
				status,
				lastRunAt: null,
				processed: null,
				failed: null,
				error: null,
			},
		]),
	) as SyncTasksState;
}

export function shouldRunOwnedSync(input: {
	isInitialized: boolean;
	ownedByWebsite: boolean;
	isVisible: boolean;
	hasWallet: boolean;
	hasServices: boolean;
	hasIdentity: boolean;
	hasAddressManager: boolean;
}): boolean {
	return Object.values(input).every(Boolean);
}

export interface SyncCoordinator {
	/**
	 * Runs `names` (every task by default) in order. A run asked for while one
	 * is in flight joins it when that run covers every name asked for;
	 * otherwise it starts once that run ends. A `silent` run (the inbox timer's)
	 * never shows as running and publishes a task only when its outcome changed.
	 */
	run: (
		jobs: SyncJobs,
		names?: readonly SyncTaskName[],
		options?: { silent?: boolean },
	) => { promise: Promise<boolean>; started: boolean };
	reset: (status?: SyncTaskStatus) => void;
	stop: () => Promise<void>;
}

/** Coordinates the upstream one-shot actions without overlapping runs. */
export function createSyncCoordinator(
	onChange: (state: SyncTasksState) => void,
	now: () => number = Date.now,
): SyncCoordinator {
	let state = createSyncTasksState();
	let generation = 0;
	let active: Promise<boolean> | null = null;
	let activeNames: readonly SyncTaskName[] = [];
	let queued: Promise<boolean> | null = null;

	const emit = (next: SyncTasksState) => {
		state = next;
		onChange(next);
	};

	const update = (name: SyncTaskName, task: SyncTaskState) => {
		emit({ ...state, [name]: task });
	};

	const sameOutcome = (a: SyncTaskState, b: SyncTaskState) =>
		a.status === b.status &&
		a.processed === b.processed &&
		a.failed === b.failed &&
		a.error === b.error;

	const run: SyncCoordinator["run"] = (jobs, names = TASK_NAMES, options) => {
		const silent = options?.silent === true;
		// A silent run leaves an unchanged outcome alone, so the page stays still.
		const finish = (name: SyncTaskName, task: SyncTaskState) => {
			if (silent && sameOutcome(state[name], task)) return;
			update(name, task);
		};
		if (active) {
			if (names.every((name) => activeNames.includes(name))) {
				return { promise: active, started: false };
			}
			if (queued) return { promise: queued, started: false };
			// A wider run asked for during a narrower one (the inbox timer's)
			// starts when that one ends, unless the identity changed meanwhile.
			const requestedGeneration = generation;
			const pending: Promise<boolean> = active.then(() => {
				if (queued === pending) queued = null;
				if (requestedGeneration !== generation) return false;
				return run(jobs, names, options).promise;
			});
			queued = pending;
			return { promise: pending, started: true };
		}

		const runGeneration = generation;
		activeNames = names;
		active = (async () => {
			for (const name of TASK_NAMES) {
				if (!names.includes(name)) continue;
				const job = jobs[name];
				if (!job) continue;
				if (runGeneration !== generation) return false;
				if (!silent) {
					update(name, { ...state[name], status: "running", error: null });
				}
				try {
					const result = await job();
					if (runGeneration !== generation) return false;
					finish(name, {
						status: result.failed > 0 ? "failed" : "succeeded",
						lastRunAt: now(),
						processed: result.processed,
						failed: result.failed,
						error:
							result.failed > 0
								? `${result.failed} item${result.failed === 1 ? "" : "s"} failed`
								: null,
					});
				} catch (error) {
					reportDiagnostic({
						category: "provider",
						code: "provider.failed",
						operation: `wallet.sync.${name}`,
						recoverable: true,
					});
					console.error(`[sync] ${name} task threw`, error);
					if (runGeneration !== generation) return false;
					finish(name, {
						status: "failed",
						lastRunAt: now(),
						processed: null,
						failed: null,
						error: "Sync task failed. Try again.",
					});
				}
			}
			return runGeneration === generation;
		})();
		const startedPromise = active;
		void startedPromise.finally(() => {
			if (active === startedPromise) active = null;
		});
		return { promise: startedPromise, started: true };
	};

	return {
		run,
		reset(status = "idle") {
			generation += 1;
			emit(createSyncTasksState(status));
		},
		async stop() {
			generation += 1;
			const pending = active;
			if (pending) await pending;
			if (active === pending) active = null;
			if (queued) await queued;
		},
	};
}

interface UseSyncEngineOptions {
	isInitialized: boolean;
	ownedByWebsite: boolean;
	wallet: WalletInterface | null;
	services: OneSatServices | null;
	identityKey: string | null;
	chain: "main" | "test";
	addressManagerReady: boolean;
	addressManagerRef: React.RefObject<AddressManager | null>;
	/** The 1Color context (manager as admin). Null off testnet. */
	colorContext: OneSatContext | null;
	/** The 1Color overlay, for `resolveOrigin`. Null off testnet. */
	colorOverlay: ColorOverlayResolver | null;
	syncRevision: number;
	refreshBalance: () => void;
	/** After the handle inbox took 1Color tokens. */
	onOneColorReceived: () => void;
}

export interface SyncEngineResult {
	syncEngineActive: boolean;
	syncTasks: SyncTasksState;
	syncWallet: () => void;
	stopSyncWorkers: () => Promise<void>;
}

export function useSyncEngine({
	isInitialized,
	ownedByWebsite,
	wallet,
	services,
	identityKey,
	chain,
	addressManagerReady,
	addressManagerRef,
	colorContext,
	colorOverlay,
	syncRevision,
	refreshBalance,
	onOneColorReceived,
}: UseSyncEngineOptions): SyncEngineResult {
	const [syncTasks, setSyncTasks] = useState(createSyncTasksState);
	const [isVisible, setIsVisible] = useState(
		typeof document === "undefined" || document.visibilityState !== "hidden",
	);
	const coordinatorRef = useRef<SyncCoordinator | null>(null);
	if (!coordinatorRef.current) {
		coordinatorRef.current = createSyncCoordinator(setSyncTasks);
	}
	const coordinator = coordinatorRef.current;

	const canRun = shouldRunOwnedSync({
		isInitialized,
		ownedByWebsite,
		isVisible,
		hasWallet: !!wallet,
		hasServices: !!services,
		hasIdentity: !!identityKey,
		hasAddressManager: addressManagerReady && !!addressManagerRef.current,
	});

	// The handle inbox (BRC-232 deliveries, BRC-169 handle payments). Where the
	// chain has 1Color it runs on the color context only: its `p color`
	// basket insertions are the module's. Elsewhere it runs on the raw wallet,
	// like the other inboxes, and leaves 1Color deliveries in the box.
	const oneColorChain = isOneColorAvailable(chain);
	const handleInboxSync = useMemo(() => {
		if (oneColorChain) {
			if (!colorContext || !colorOverlay) return null;
			return createHandleInboxSync(colorContext, {
				overlayFor: (assetId) => colorOverlay.resolveOrigin(assetId),
			});
		}
		if (!wallet || !services) return null;
		return createHandleInboxSync(
			createActionContext(wallet, { chain, services }),
		);
	}, [oneColorChain, colorContext, colorOverlay, wallet, services, chain]);

	const runSync = useCallback(
		(names: readonly SyncTaskName[] = TASK_NAMES) => {
			const addressManager = addressManagerRef.current;
			if (!canRun || !wallet || !services || !identityKey || !addressManager) {
				return;
			}

			const ctx = createActionContext(wallet, { chain, services });
			const { messagebox: messageboxUrl } = endpointsOf(chain);
			const count = addressManager.getAddresses().length || 5;
			let inboxReceived = false;
			let oneColorReceived = false;
			const { promise, started } = coordinator.run(
				{
					addresses: () =>
						syncAddresses.execute(ctx, {
							prefix: RECEIVE_ADDRESS_PREFIX,
							count,
						}),
					// The built-in wallet's own BRC-29 Receive addresses, which
					// `syncAddresses` does not derive. Its own store and cursor.
					receiveAddresses: () =>
						syncReceiveAddresses(
							ctx,
							addressManager,
							openReceiveAddressStore(chain, identityKey),
						),
					// PeerPay on every read box first, then paymail on the own box.
					payments: async () => {
						const peerPay = await syncAccountPeerPayInbox(
							wallet,
							chain,
							identityKey,
						);
						let paymail = null;
						try {
							paymail = await syncMessages.execute(ctx, { messageboxUrl });
						} catch (error) {
							paymailSyncFailed(error);
						}
						return combineInboxResults(peerPay, paymail);
					},
					cosignDeliveries: () =>
						syncCosignDeliveries.execute(ctx, { messageboxUrl }),
					handleInbox: async () => {
						// On a 1Color chain the inbox waits for the color context; the
						// next run after it is set reads the box.
						if (!handleInboxSync) return { processed: 0, failed: 0 };
						const result = await handleInboxSync();
						inboxReceived = result.processed > 0;
						oneColorReceived = result.assetIds.length > 0;
						return result;
					},
				},
				names,
				{ silent: names === HANDLE_INBOX_ONLY },
			);

			if (started) {
				void promise.then((isCurrentIdentity) => {
					if (!isCurrentIdentity) return;
					if (names !== HANDLE_INBOX_ONLY || inboxReceived) refreshBalance();
					if (oneColorReceived) onOneColorReceived();
				});
			}
		},
		[
			addressManagerRef,
			canRun,
			wallet,
			services,
			identityKey,
			chain,
			coordinator,
			handleInboxSync,
			refreshBalance,
			onOneColorReceived,
		],
	);

	useEffect(() => {
		const onVisibilityChange = () =>
			setIsVisible(document.visibilityState !== "hidden");
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () =>
			document.removeEventListener("visibilitychange", onVisibilityChange);
	}, []);

	useEffect(() => {
		coordinator.reset(
			isInitialized && identityKey && !ownedByWebsite
				? "provider-managed"
				: "idle",
		);
	}, [coordinator, identityKey, isInitialized, ownedByWebsite]);

	useEffect(() => {
		if (!canRun) return;
		void syncRevision;
		runSync();
	}, [canRun, runSync, syncRevision]);

	// Handle deliveries arrive any time: collect them on a timer while visible.
	useEffect(() => {
		if (!canRun) return;
		const timer = setInterval(
			() => runSync(HANDLE_INBOX_ONLY),
			HANDLE_INBOX_SYNC_INTERVAL_MS,
		);
		return () => clearInterval(timer);
	}, [canRun, runSync]);

	const stopSyncWorkers = useCallback(() => coordinator.stop(), [coordinator]);

	const syncWallet = useCallback(() => {
		refreshBalance();
		runSync();
	}, [runSync, refreshBalance]);

	const syncEngineActive = useMemo(
		() => TASK_NAMES.some((name) => syncTasks[name].status === "running"),
		[syncTasks],
	);

	return {
		syncEngineActive,
		syncTasks,
		syncWallet,
		stopSyncWorkers,
	};
}
