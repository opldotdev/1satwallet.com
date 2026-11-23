"use client";

/**
 * Wallet Toolbox Provider
 *
 * Integrates @1sat/wallet-browser wallet + address sync with receive address
 * rotation and TanStack Query powered balance refresh.
 */

import {
	type Bsv21Balance,
	createContext as createOneSatContext,
	deriveDepositAddresses,
	type OneSatContext,
	type WalletOutput,
} from "@1sat/actions";
import type { OneSatServices } from "@1sat/client";
import {
	connectWallet,
	createWalletSession,
	type WalletSession,
} from "@1sat/connect";
import { createAssetPermissionModules } from "@1sat/permission-module";
import {
	type AddressManager,
	createWebWallet,
	type WebWalletResult,
} from "@1sat/wallet-browser";
import { Beef, PrivateKey, type WalletInterface } from "@bsv/sdk";
import { WalletPermissionsManager } from "@bsv/wallet-toolbox-client";
import { useQueryClient } from "@tanstack/react-query";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useExchangeRate } from "@/hooks/use-exchange-rate";
import { requestAssetPermission } from "@/lib/cwi/asset-permission-prompt";
import {
	advanceReceiveAddress,
	buildReceiveAddressManager,
	getActiveReceiveAddresses,
	getDepositAddress,
	RECEIVE_ADDRESS_PREFIX,
	RECEIVE_ADDRESS_WINDOW,
} from "@/lib/receive-address-manager";
import {
	createDefaultReceiveAddressState,
	loadReceiveAddressState,
	type ReceiveAddressState,
	saveReceiveAddressState,
} from "@/lib/receive-address-state";
import {
	errorNameOf,
	reportDiagnostic,
	reportFailure,
} from "@/lib/runtime-diagnostics";
import { createStackServices } from "@/lib/stack";
import type { AssetSurfaceState } from "@/lib/wallet/asset-query-state";
import {
	createColorContext,
	createWalletColorModule,
} from "@/lib/wallet/color-module";
import type { ColorOverlay } from "@/lib/wallet/color-overlay";
import {
	CONNECTION_OPTION_KEY,
	clearConnection,
	persistBuiltInConnection,
	persistExternalConnection,
	WALLET_CONNECTION_MODE_KEY,
} from "@/lib/wallet/connection-mode";
import {
	connectSelectedWallet,
	prepareWalletSwitch,
	type WalletConnectionOption,
} from "@/lib/wallet/connection-options";
import {
	EXTERNAL_NETWORK_CHANGED,
	externalWalletChain,
} from "@/lib/wallet/external-network";
import type { MigrationTarget } from "@/lib/wallet/first-run-migration";
import { createWalletContext } from "@/lib/wallet/legacy-baskets";
import { guardModuleIdentifiers } from "@/lib/wallet/module-identifier-guard";
import { PERMISSIONS_CONFIG } from "@/lib/wallet/permissions-config";
import {
	providerCapability,
	surfaceForConnection,
} from "@/lib/wallet/provider-capabilities";
import { isRateLimited, withRateLimitRetry } from "@/lib/wallet/rate-limit";
import { walletStorageUrl } from "@/lib/wallet/storage-endpoint";
import {
	hasStoredWallet,
	readWalletChain,
	refreshWalletChain,
	storedAccountNetwork,
} from "@/lib/wallet-chain";
import {
	diagnoseNoWalletResult,
	statusAfterDisconnect,
	type WalletConnectionStatus,
} from "@/lib/wallet-connection-status";
import { loadOrCreateWalletStorageIdentity } from "@/lib/wallet-storage-identity";
import { type SyncTasksState, useSyncEngine } from "./hooks/use-sync-engine";
import { useWalletBalance } from "./hooks/use-wallet-balance";
import { useWalletDiagnostics } from "./hooks/use-wallet-diagnostics";
import { useWallet } from "./wallet-provider";

type Chain = "main" | "test";
export type WalletConnectionMode = "none" | "built-in" | "external";
type DisposablePermissionModule = { dispose: () => void };

export { WALLET_CONNECTION_MODE_KEY };

/**
 * Set when a connect or a switch found the external wallet on another network
 * and moved the active chain to it; the value says which. The automatic
 * reconnect on that chain clears it; if the networks still differ then, it
 * fails instead of moving again.
 */
const EXTERNAL_HOP_KEY = "1sat-wallet-external-hop";
type ExternalHop = "connect" | "switch";

/** Shown after a switch's reconnect on the new chain failed: the wallet in use before was closed by the move. */
const SWITCH_HOP_FAILED =
	"The wallet switch did not finish, and the wallet you were using was disconnected.";

function externalHop(): ExternalHop | null {
	try {
		const hop = sessionStorage.getItem(EXTERNAL_HOP_KEY);
		if (hop === null) return null;
		return hop === "switch" ? "switch" : "connect";
	} catch {
		reportDiagnostic({
			category: "provider",
			code: "provider.failed",
			operation: "wallet.external.hop.read",
			recoverable: true,
		});
		return null;
	}
}

const hasExternalHop = (): boolean => externalHop() !== null;

function setExternalHop(hop: ExternalHop | null): void {
	try {
		if (hop) sessionStorage.setItem(EXTERNAL_HOP_KEY, hop);
		else sessionStorage.removeItem(EXTERNAL_HOP_KEY);
	} catch {
		reportDiagnostic({
			category: "provider",
			code: "provider.failed",
			operation: "wallet.external.hop.write",
			recoverable: true,
		});
	}
}

/**
 * A connection error raised while clearing a connection that moves the active
 * chain: the provider remounts on the other chain, and the new instance shows
 * the error instead of losing it.
 */
let carriedInitError: string | null = null;

// The wallet's own originator: a host with an optional port, the only form
// the toolbox's validateOriginator accepts. Apps never match it exactly: the
// relay and the redirect flow pass an app's hostname without a port.
const ADMIN_ORIGINATOR =
	typeof window !== "undefined" ? window.location.host : "1satwallet.com";

interface WalletBalance {
	confirmed: number;
	unconfirmed: number;
	total: number;
}

interface SyncStatus {
	isSyncing: boolean;
	progress: null;
	lastSync: Date | null;
	error: string | null;
}

type SyncEventLevel = "log" | "warn" | "error";

export interface SyncEvent {
	id: number;
	timestamp: number;
	level: SyncEventLevel;
	source: string;
	message: string;
	correlationId: string;
	category: "route" | "action" | "provider";
	code: string;
	operation: string;
	recoverable: boolean;
	context: Record<string, string | number | boolean | null>;
}

export type WalletEvent =
	| {
			id: number;
			timestamp: number;
			type: "broadcast";
			txid: string;
			status: string;
	  }
	| {
			id: number;
			timestamp: number;
			type: "proven";
			txid: string;
			blockHeight: number;
			blockHash: string;
	  }
	| {
			id: number;
			timestamp: number;
			type: "sync:progress";
			stage: string;
			message: string;
	  }
	| { id: number; timestamp: number; type: "sync:backup"; message: string }
	| {
			id: number;
			timestamp: number;
			type: "task:run";
			taskName: string;
			result: string;
	  }
	| {
			id: number;
			timestamp: number;
			type: "error";
			source: string;
			message: string;
	  }
	| {
			id: number;
			timestamp: number;
			type: "log";
			level: SyncEventLevel;
			source: string;
			message: string;
	  };

interface WalletToolboxContextValue {
	wallet: WalletInterface | null;
	permissionsManager: WalletPermissionsManager | null;
	services: OneSatServices | null;
	connectionMode: WalletConnectionMode;
	connectionStatus: WalletConnectionStatus;
	providerType: string | null;
	isInitialized: boolean;
	isInitializing: boolean;
	initError: string | null;
	/** Show why the built-in wallet did not start (the bridge's own failures). */
	reportInitFailure: (message: string) => void;
	chain: Chain;
	identityKey: string | null;

	depositAddress: string | null;
	receiveAddressIndex: number;
	receiveAddresses: string[];
	addressManagerReady: boolean;
	lastRotationOutpoint: string | null;

	syncStatus: SyncStatus;
	syncTasks: SyncTasksState;
	syncWallet: () => void;
	syncEvents: SyncEvent[];
	clearSyncEvents: () => void;
	walletEvents: WalletEvent[];
	clearWalletEvents: () => void;
	hasActiveSync: boolean;

	oneSatContext: OneSatContext | null;
	/** 1Color writes and the inbox: the permissions manager as the admin. Null off testnet. */
	colorContext: OneSatContext | null;
	/** The 1Color overlay, for `resolveOrigin`. Null off testnet. */
	colorOverlay: ColorOverlay | null;

	balance: WalletBalance | null;
	ordinals: WalletOutput[];
	bsv20Tokens: Bsv21Balance[];
	bsv21Tokens: Bsv21Balance[];
	legacyBalance: number;
	legacyFundingUtxos: {
		outpoint: string;
		satoshis: number;
	}[];
	isBalanceLoading: boolean;
	balanceError: Error | null;
	ordinalsState: AssetSurfaceState;
	bsv21State: AssetSurfaceState;

	exchangeRate: number | null;

	/**
	 * Opens the built-in wallet at `rootKeyHex`. Resolves with the new wallet
	 * (the context value only reflects it after the next render), or null when
	 * it could not open.
	 */
	initializeWallet: (rootKeyHex: string) => Promise<MigrationTarget | null>;
	connectExternalWallet: (option?: WalletConnectionOption) => Promise<boolean>;
	switchWallet: (option: WalletConnectionOption) => Promise<boolean>;
	disconnectExternalWallet: () => Promise<void>;
	destroyWallet: () => Promise<void>;
	refreshBalance: () => void;
}

const WalletToolboxContext = createContext<
	WalletToolboxContextValue | undefined
>(undefined);

function parseOutpoint(
	outpoint: string,
): { txid: string; vout: number } | null {
	const underscoreIndex = outpoint.lastIndexOf("_");
	if (underscoreIndex <= 0) {
		return null;
	}
	const txid = outpoint.slice(0, underscoreIndex);
	const voutRaw = outpoint.slice(underscoreIndex + 1);
	const vout = Number.parseInt(voutRaw, 10);
	if (!txid || Number.isNaN(vout) || vout < 0) {
		return null;
	}
	return { txid, vout };
}

interface WalletToolboxProviderProps {
	children: ReactNode;
	chain?: Chain;
}

export function WalletToolboxProvider({
	children,
	chain = "main",
}: WalletToolboxProviderProps) {
	const queryClient = useQueryClient();
	const { rate: exchangeRate } = useExchangeRate();
	const { hasWallet: hasBuiltInWallet } = useWallet();

	// -- Core wallet state --
	const [wallet, setWallet] = useState<WalletInterface | null>(null);
	const [permissionsManager, setPermissionsManager] =
		useState<WalletPermissionsManager | null>(null);
	const [services, setServices] = useState<OneSatServices | null>(null);
	const [identityKey, setIdentityKey] = useState<string | null>(null);
	const [connectionMode, setConnectionMode] =
		useState<WalletConnectionMode>("none");
	const [connectionStatus, setConnectionStatus] =
		useState<WalletConnectionStatus>("no-wallet");
	const [providerType, setProviderType] = useState<string | null>(null);
	const walletResultRef = useRef<WebWalletResult | null>(null);
	// The built-in wallet's manager and overlay, kept beside walletResultRef so
	// switching back from an external wallet restores them.
	const localPermissionsRef = useRef<{
		manager: WalletPermissionsManager;
		colorOverlay: ColorOverlay | null;
	} | null>(null);
	// The built-in wallet's identity and receive addresses, kept current across
	// rotations, so switching back from an external wallet restores them too.
	const localReceiveRef = useRef<{
		identityKey: string;
		addressManager: AddressManager;
		state: ReceiveAddressState;
	} | null>(null);
	const walletSessionRef = useRef<WalletSession | null>(null);
	const walletSessionCleanupRef = useRef<() => void>(() => {});
	const externalServicesRef = useRef<OneSatServices | null>(null);
	const connectionGenerationRef = useRef(0);
	const teardownPromiseRef = useRef<Promise<void> | null>(null);
	const assetPermissionModulesRef = useRef<DisposablePermissionModule[]>([]);
	const [colorOverlay, setColorOverlay] = useState<ColorOverlay | null>(null);

	const [isInitialized, setIsInitialized] = useState(false);
	const [isInitializing, setIsInitializing] = useState(false);
	const initGuardRef = useRef(false);
	const [initError, setInitError] = useState<string | null>(null);

	const reportInitFailure = useCallback((message: string) => {
		setInitError(message);
	}, []);

	useEffect(() => {
		const carried = carriedInitError;
		carriedInitError = null;
		if (carried) setInitError(carried);
	}, []);

	/** Forget the persisted connection and show why. */
	const failConnection = useCallback(
		(message: string) => {
			carriedInitError = message;
			setExternalHop(null);
			clearConnection();
			// Same chain: no remount, so this instance shows the error.
			if (readWalletChain() === chain) carriedInitError = null;
			setInitError(message);
		},
		[chain],
	);

	// -- Receive address state --
	const [depositAddress, setDepositAddress] = useState<string | null>(null);
	const [receiveAddressIndex, setReceiveAddressIndex] = useState(0);
	const [receiveAddresses, setReceiveAddresses] = useState<string[]>([]);
	const [trackedAddresses, setTrackedAddresses] = useState<string[]>([]);
	const [addressManagerReady, setAddressManagerReady] = useState(false);
	const [lastRotationOutpoint, setLastRotationOutpoint] = useState<
		string | null
	>(null);

	const addressManagerRef = useRef<AddressManager | null>(null);
	const [initialReceiveState] = useState<ReceiveAddressState>(() =>
		createDefaultReceiveAddressState(RECEIVE_ADDRESS_WINDOW),
	);
	const [initialSeenOutpoints] = useState(() => new Set<string>());
	const [initialRotatingOutpoints] = useState(() => new Set<string>());
	const receiveStateRef = useRef(initialReceiveState);
	const seenOutpointsRef = useRef(initialSeenOutpoints);
	const rotatingOutpointsRef = useRef(initialRotatingOutpoints);
	const [syncRevision, setSyncRevision] = useState(0);

	// -- Diagnostics hook --
	const { syncEvents, clearSyncEvents, walletEvents, clearWalletEvents } =
		useWalletDiagnostics({
			connectionStatus,
			connectionMode,
			providerType,
			isInitialized,
			initFailed: initError !== null,
		});

	// -- OneSat action context --
	const oneSatContext = useMemo<OneSatContext | null>(() => {
		if (!wallet) return null;
		return createWalletContext(wallet, {
			services: services ?? undefined,
			chain,
			builtIn: connectionMode === "built-in",
		});
	}, [wallet, services, chain, connectionMode]);

	const colorContext = useMemo<OneSatContext | null>(() => {
		if (!permissionsManager || !colorOverlay || connectionMode !== "built-in")
			return null;
		return createColorContext(permissionsManager, {
			adminOriginator: ADMIN_ORIGINATOR,
			chain,
			services: services ?? undefined,
		});
	}, [permissionsManager, colorOverlay, services, chain, connectionMode]);

	// -- Balance hook --
	const savedConnectionOption =
		typeof window === "undefined"
			? null
			: localStorage.getItem(CONNECTION_OPTION_KEY);
	const assetRead = providerCapability(
		surfaceForConnection(
			connectionMode,
			savedConnectionOption === "injected" ||
				savedConnectionOption === "desktop" ||
				savedConnectionOption === "embedded"
				? savedConnectionOption
				: providerType,
		),
		"asset-read",
	);
	const balanceResult = useWalletBalance({
		ctx: oneSatContext,
		isInitialized,
		identityKey,
		trackedAddresses,
		includeLegacyFunding: connectionMode === "built-in",
		assetRead,
	});
	const {
		refreshBalance,
		balance,
		ordinals,
		bsv21Balances,
		legacyBalance,
		legacyFundingUtxos,
		ordinalsState,
		bsv21State,
		isBalanceLoading,
		balanceError,
		syncStatus: balanceSyncStatus,
	} = balanceResult;

	// -- Outpoint script resolution --
	const resolveOutpointScript = useCallback(
		async (outpoint: string): Promise<string | null> => {
			if (!services) return null;
			const parsed = parseOutpoint(outpoint);
			if (!parsed) return null;

			const beef = await services.beef.getBeef(parsed.txid);
			if (!beef) return null;

			const beefTx = Beef.fromBinary(Array.from(beef));
			const btx = beefTx.findTxid(parsed.txid);
			const output = btx?.tx?.outputs[parsed.vout];
			if (!output) return null;

			return output.lockingScript.toHex();
		},
		[services],
	);

	// -- Queued outpoint handler (receive address rotation) --
	const _handleQueuedOutpoint = useCallback(
		async (outpoint: string, _score: number) => {
			const addressManager = addressManagerRef.current;
			const receiveState = receiveStateRef.current;
			if (!wallet || !identityKey || !addressManager || !addressManagerReady) {
				return;
			}

			if (seenOutpointsRef.current.has(outpoint)) {
				return;
			}
			seenOutpointsRef.current.add(outpoint);
			if (seenOutpointsRef.current.size > 2000) {
				const oldest = seenOutpointsRef.current.values().next().value;
				if (oldest) {
					seenOutpointsRef.current.delete(oldest);
				}
			}

			const outputScript = await resolveOutpointScript(outpoint);
			if (!outputScript) {
				return;
			}
			const normalizedOutputScript = outputScript.toLowerCase();

			const currentScript = addressManager.getLockingScriptAtIndex(
				receiveState.currentIndex,
			);
			if (!currentScript) {
				return;
			}
			const normalizedCurrentScript = currentScript.toLowerCase();

			if (normalizedOutputScript !== normalizedCurrentScript) {
				return;
			}

			if (receiveState.lastRotationOutpoint === outpoint) {
				return;
			}

			if (rotatingOutpointsRef.current.has(outpoint)) {
				return;
			}
			rotatingOutpointsRef.current.add(outpoint);

			try {
				const advanced = await advanceReceiveAddress({
					wallet,
					chain,
					identityKey,
					state: receiveState,
					addressManager,
					rotationOutpoint: outpoint,
					prefix: RECEIVE_ADDRESS_PREFIX,
					originator: ADMIN_ORIGINATOR,
				});

				receiveStateRef.current = advanced.state;
				addressManagerRef.current = advanced.addressManager;
				if (localReceiveRef.current?.identityKey === identityKey) {
					localReceiveRef.current = {
						identityKey,
						addressManager: advanced.addressManager,
						state: advanced.state,
					};
				}

				saveReceiveAddressState({ chain, identityKey }, advanced.state);

				setReceiveAddressIndex(advanced.state.currentIndex);
				setDepositAddress(advanced.depositAddress);
				setReceiveAddresses(
					getActiveReceiveAddresses(advanced.addressManager, advanced.state),
				);
				setTrackedAddresses(advanced.addressManager.getAddresses());
				setLastRotationOutpoint(advanced.state.lastRotationOutpoint ?? null);

				setSyncRevision((prev) => prev + 1);
				refreshBalance();
			} catch {
				reportDiagnostic({
					category: "provider",
					code: "provider.failed",
					operation: "wallet.receive.rotate",
					recoverable: true,
					context: { retryable: true },
				});
			} finally {
				rotatingOutpointsRef.current.delete(outpoint);
			}
		},
		[
			wallet,
			identityKey,
			addressManagerReady,
			resolveOutpointScript,
			chain,
			refreshBalance,
		],
	);

	// -- Sync engine hook --
	const onOneColorReceived = useCallback(() => {
		void queryClient.invalidateQueries({ queryKey: ["one-color"] });
	}, [queryClient]);
	const syncEngine = useSyncEngine({
		isInitialized,
		ownedByWebsite: connectionMode === "built-in",
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
	});
	const { stopSyncWorkers, syncWallet, syncEngineActive, syncTasks } =
		syncEngine;

	const clearIdentityQueries = useCallback(() => {
		queryClient.removeQueries({ queryKey: ["wallet-balance"] });
		queryClient.removeQueries({ queryKey: ["wallet-actions"] });
		queryClient.removeQueries({ queryKey: ["bap-profile"] });
		queryClient.removeQueries({ queryKey: ["opns-names"] });
		queryClient.removeQueries({ queryKey: ["one-color"] });
		queryClient.removeQueries({ queryKey: ["wallet-handles"] });
	}, [queryClient]);

	const resetWalletState = useCallback(
		(status: WalletConnectionStatus) => {
			clearIdentityQueries();

			setWallet(null);
			setPermissionsManager(null);
			setColorOverlay(null);
			setServices(null);
			setIdentityKey(null);
			setConnectionMode("none");
			setConnectionStatus(status);
			setProviderType(null);
			setDepositAddress(null);
			setReceiveAddressIndex(0);
			setReceiveAddresses([]);
			setTrackedAddresses([]);
			setAddressManagerReady(false);
			setLastRotationOutpoint(null);
			setIsInitialized(false);
			setSyncRevision(0);
			addressManagerRef.current = null;
			receiveStateRef.current = createDefaultReceiveAddressState(
				RECEIVE_ADDRESS_WINDOW,
			);
			seenOutpointsRef.current = new Set();
			rotatingOutpointsRef.current = new Set();
		},
		[clearIdentityQueries],
	);

	const deriveExternalAddresses = useCallback(
		async (
			externalWallet: WalletInterface,
			externalServices: OneSatServices,
		) => {
			const context = createOneSatContext(externalWallet, {
				services: externalServices,
				chain,
			});
			const { derivations } = await deriveDepositAddresses.execute(context, {
				count: 1,
			});
			return derivations.map(({ address }) => address);
		},
		[chain],
	);

	const teardownWallet = useCallback(
		(
			status: WalletConnectionStatus,
			options?: { destroyLocal?: boolean; keepConnection?: boolean },
		): Promise<void> => {
			if (teardownPromiseRef.current) return teardownPromiseRef.current;

			connectionGenerationRef.current += 1;
			initGuardRef.current = false;
			setIsInitializing(false);

			const session = walletSessionRef.current;
			walletSessionRef.current = null;
			walletSessionCleanupRef.current();
			walletSessionCleanupRef.current = () => {};
			if (session?.status === "connected") {
				// This closes only the local transport/session. BRC-100 does not define
				// provider-side grant revocation for a dapp disconnect.
				session.disconnect("manual");
			} else {
				session?.stop();
			}

			const destroyLocal = options?.destroyLocal !== false;
			const webWallet = destroyLocal ? walletResultRef.current : null;
			if (destroyLocal) {
				walletResultRef.current = null;
				localPermissionsRef.current = null;
				localReceiveRef.current = null;
				for (const module of assetPermissionModulesRef.current)
					module.dispose();
				assetPermissionModulesRef.current = [];
			}
			// Clearing an external session moves the chain back to the built-in
			// account's network (or mainnet).
			if (!options?.keepConnection) clearConnection();
			externalServicesRef.current?.close();
			externalServicesRef.current = null;
			resetWalletState(status);

			const teardown = (async () => {
				await stopSyncWorkers();
				try {
					await webWallet?.destroy();
				} catch {
					reportDiagnostic({
						category: "provider",
						code: "provider.failed",
						operation: "wallet.teardown",
						recoverable: true,
					});
				}
			})().finally(() => {
				if (teardownPromiseRef.current === teardown) {
					teardownPromiseRef.current = null;
				}
			});
			teardownPromiseRef.current = teardown;
			return teardown;
		},
		[resetWalletState, stopSyncWorkers],
	);

	const connectExternal = useCallback(
		async (
			option: WalletConnectionOption | undefined,
			resume: boolean,
		): Promise<boolean> => {
			// After a switch moved the chain, a failed reconnect cannot leave the
			// old wallet in place: the move already closed it.
			const switchHop = resume && externalHop() === "switch";
			const afterSwitchHop = (message: string) =>
				switchHop ? `${message} ${SWITCH_HOP_FAILED}` : message;
			if (!resume) setExternalHop(null);
			const pendingTeardown = teardownPromiseRef.current;
			if (pendingTeardown) await pendingTeardown;
			if (initGuardRef.current) {
				return false;
			}

			const generation = ++connectionGenerationRef.current;
			initGuardRef.current = true;
			setIsInitializing(true);
			setConnectionStatus("authenticating");
			setInitError(null);

			let pendingResult: Awaited<ReturnType<typeof connectWallet>> = null;
			try {
				const result = option
					? await connectSelectedWallet(option)
					: await connectWallet({ autoDetect: true });
				pendingResult = result;
				if (generation !== connectionGenerationRef.current) {
					result?.disconnect();
					return false;
				}
				if (!result) {
					const diagnostic = await diagnoseNoWalletResult();
					if (generation !== connectionGenerationRef.current) return false;
					setConnectionStatus(diagnostic.status);
					failConnection(afterSwitchHop(diagnostic.message));
					initGuardRef.current = false;
					return false;
				}

				// The external wallet's network becomes the active chain.
				const reported = await externalWalletChain(result.wallet);
				if (generation !== connectionGenerationRef.current) {
					pendingResult = null;
					result.disconnect();
					return false;
				}
				if ("error" in reported || reported.chain !== chain) {
					pendingResult = null;
					result.disconnect();
					initGuardRef.current = false;
					if (!("error" in reported) && !hasExternalHop()) {
						// Reconnect on the wallet's chain: the store change remounts
						// this provider there, and its auto-reconnect connects again.
						setExternalHop("connect");
						persistExternalConnection(reported.chain, option);
						return false;
					}
					setConnectionStatus("disconnected");
					failConnection(
						afterSwitchHop(
							"error" in reported ? reported.error : EXTERNAL_NETWORK_CHANGED,
						),
					);
					return false;
				}

				const externalServices = createStackServices(chain);
				let addresses: string[];
				try {
					addresses = await deriveExternalAddresses(
						result.wallet,
						externalServices,
					);
				} catch (error) {
					externalServices.close();
					result.disconnect();
					throw error;
				}
				if (generation !== connectionGenerationRef.current) {
					externalServices.close();
					result.disconnect();
					return false;
				}
				externalServicesRef.current = externalServices;

				setWallet(result.wallet);
				setServices(externalServices);
				setPermissionsManager(null);
				setIdentityKey(result.identityKey);
				setDepositAddress(addresses[0] ?? null);
				setReceiveAddresses(addresses);
				setTrackedAddresses(addresses);
				setAddressManagerReady(false);
				setConnectionMode("external");
				setConnectionStatus("ready");
				setProviderType(result.provider);
				setIsInitialized(true);

				setExternalHop(null);
				persistExternalConnection(chain, option);

				const session = createWalletSession(result);
				walletSessionRef.current = session;
				const unsubscribeIdentity = session.on("identityChange", ({ next }) => {
					if (walletSessionRef.current !== session) return;
					const identityGeneration = ++connectionGenerationRef.current;
					clearIdentityQueries();
					setIsInitialized(false);
					setIdentityKey(null);
					setDepositAddress(null);
					setReceiveAddresses([]);
					setTrackedAddresses([]);
					setConnectionStatus("authenticating");
					void deriveExternalAddresses(result.wallet, externalServices)
						.then((nextAddresses) => {
							if (
								identityGeneration !== connectionGenerationRef.current ||
								walletSessionRef.current !== session
							) {
								return;
							}
							setIdentityKey(next);
							setDepositAddress(nextAddresses[0] ?? null);
							setReceiveAddresses(nextAddresses);
							setTrackedAddresses(nextAddresses);
							setConnectionStatus("ready");
							setIsInitialized(true);
							setInitError(null);
						})
						.catch(() => {
							if (identityGeneration !== connectionGenerationRef.current)
								return;
							setInitError(
								"Wallet identity refresh failed. Reconnect and try again.",
							);
							void teardownWallet("disconnected");
						});
				});
				const unsubscribeDisconnected = session.on(
					"disconnected",
					({ reason }) => {
						if (walletSessionRef.current !== session) return;
						void teardownWallet(statusAfterDisconnect(reason));
					},
				);
				walletSessionCleanupRef.current = () => {
					unsubscribeIdentity();
					unsubscribeDisconnected();
				};
				session.start();

				return true;
			} catch (error) {
				if (generation !== connectionGenerationRef.current) return false;
				connectionGenerationRef.current += 1;
				reportDiagnostic({
					category: "provider",
					code: "provider.failed",
					operation: "wallet.connect.external",
					recoverable: true,
					context: {
						mode: "external",
						provider: option ?? "auto-detect",
						errorName: errorNameOf(error),
						retryable: true,
					},
				});
				walletSessionCleanupRef.current();
				walletSessionCleanupRef.current = () => {};
				walletSessionRef.current?.stop();
				walletSessionRef.current = null;
				pendingResult?.disconnect();
				externalServicesRef.current?.close();
				externalServicesRef.current = null;
				resetWalletState("disconnected");
				// failConnection also clears the hop.
				failConnection(
					afterSwitchHop(
						"Wallet connection failed. Check the provider and try again.",
					),
				);
				setIsInitializing(false);
				initGuardRef.current = false;
				return false;
			} finally {
				if (generation === connectionGenerationRef.current) {
					setIsInitializing(false);
				}
			}
		},
		[
			chain,
			clearIdentityQueries,
			deriveExternalAddresses,
			failConnection,
			resetWalletState,
			teardownWallet,
		],
	);

	const connectExternalWallet = useCallback(
		(option?: WalletConnectionOption) => connectExternal(option, false),
		[connectExternal],
	);

	useEffect(() => {
		if (
			isInitialized ||
			isInitializing ||
			localStorage.getItem(WALLET_CONNECTION_MODE_KEY) !== "external" ||
			// About to remount on the external wallet's chain; that instance
			// reconnects.
			readWalletChain() !== chain
		) {
			return;
		}
		const savedOption = localStorage.getItem(CONNECTION_OPTION_KEY);
		void connectExternal(
			savedOption === "injected" ||
				savedOption === "desktop" ||
				savedOption === "embedded"
				? savedOption
				: undefined,
			true,
		);
	}, [chain, connectExternal, isInitialized, isInitializing]);

	// -- Wallet init --
	const initializeWallet = useCallback(
		async (rootKeyHex: string): Promise<MigrationTarget | null> => {
			const pendingTeardown = teardownPromiseRef.current;
			if (pendingTeardown) await pendingTeardown;
			if (initGuardRef.current) {
				return null;
			}
			// The keys must belong to the account stored on this chain. If the
			// wallet was replaced or removed meanwhile, move the chain and let
			// the remounted provider (or none) open it.
			const storedNetwork = storedAccountNetwork();
			if (storedNetwork !== chain) {
				if (storedNetwork === null && hasStoredWallet()) {
					setInitError(
						"This browser's saved wallet couldn't be read. Import your backup to restore it.",
					);
				}
				reportDiagnostic({
					category: "provider",
					code: "provider.failed",
					operation: "wallet.initialize.chain",
					recoverable: true,
					context: { mode: "built-in", retryable: true },
				});
				refreshWalletChain();
				return null;
			}
			const generation = ++connectionGenerationRef.current;
			initGuardRef.current = true;

			setIsInitializing(true);
			setConnectionStatus("authenticating");
			let pendingResult: WebWalletResult | null = null;
			let pendingPermissionModules: DisposablePermissionModule[] = [];
			try {
				const rootKey = PrivateKey.fromHex(rootKeyHex);
				const newIdentityKey = rootKey.toPublicKey().toString();
				const storageIdentityKey =
					await loadOrCreateWalletStorageIdentity(chain);

				const activeRemote = walletStorageUrl(chain);
				// The wallet server rate-limits; a busy moment shouldn't fail the open.
				// Stops once the wallet is locked or reopened meanwhile.
				const result = await withRateLimitRetry(
					"wallet.initialize",
					() =>
						createWebWallet({
							privateKey: rootKey,
							chain,
							activeRemote,
							storageIdentityKey,
						}),
					{
						shouldContinue: () =>
							generation === connectionGenerationRef.current,
					},
				);
				pendingResult = result;
				if (generation !== connectionGenerationRef.current) {
					await result.destroy();
					return null;
				}

				const assetPermissionModules = createAssetPermissionModules({
					wallet: result.wallet,
					promptHandler: requestAssetPermission,
					adminOriginator: ADMIN_ORIGINATOR,
					services: result.services,
				});
				// Testnet only: apps reach 1Color through the color consent,
				// prompted in the CWI relay like the 1Sat asset modules.
				const color = createWalletColorModule({
					wallet: result.wallet,
					chain,
					identityKey: newIdentityKey,
					adminOriginator: ADMIN_ORIGINATOR,
					promptHandler: requestAssetPermission,
				});
				const permissionModules = color
					? { ...assetPermissionModules, color: color.permissionModule }
					: assetPermissionModules;
				pendingPermissionModules = Object.values(permissionModules);
				// Apps reach the wallet only through this manager (CWI relay and
				// redirect authorize), so the guard covers every app-originated call.
				const wpm = guardModuleIdentifiers(
					new WalletPermissionsManager(result.wallet, ADMIN_ORIGINATOR, {
						...PERMISSIONS_CONFIG,
						permissionModules,
					}),
					ADMIN_ORIGINATOR,
				);
				const loadedState = loadReceiveAddressState(
					{ chain, identityKey: newIdentityKey },
					RECEIVE_ADDRESS_WINDOW,
				);
				const receiveState: ReceiveAddressState = {
					...loadedState,
					windowSize: RECEIVE_ADDRESS_WINDOW,
					maxDerivedIndex: Math.max(
						loadedState.maxDerivedIndex,
						loadedState.currentIndex + RECEIVE_ADDRESS_WINDOW - 1,
					),
				};

				const receiveResult = await buildReceiveAddressManager({
					wallet: result.wallet,
					chain,
					identityKey: newIdentityKey,
					state: receiveState,
					prefix: RECEIVE_ADDRESS_PREFIX,
					originator: ADMIN_ORIGINATOR,
				});
				if (generation !== connectionGenerationRef.current) {
					for (const module of pendingPermissionModules) module.dispose();
					pendingPermissionModules = [];
					await result.destroy();
					return null;
				}

				pendingResult = null;
				walletResultRef.current = result;
				localPermissionsRef.current = {
					manager: wpm,
					colorOverlay: color?.overlay ?? null,
				};
				localReceiveRef.current = {
					identityKey: newIdentityKey,
					addressManager: receiveResult.addressManager,
					state: receiveResult.state,
				};
				assetPermissionModulesRef.current = pendingPermissionModules;
				pendingPermissionModules = [];
				setWallet(result.wallet);
				setServices(result.services);

				setPermissionsManager(wpm);
				setColorOverlay(color?.overlay ?? null);
				setIdentityKey(newIdentityKey);
				setConnectionMode("built-in");
				setConnectionStatus("ready");
				setProviderType("1sat-web");
				setAddressManagerReady(true);
				setReceiveAddressIndex(receiveResult.state.currentIndex);
				setDepositAddress(receiveResult.depositAddress || null);
				setReceiveAddresses(
					getActiveReceiveAddresses(
						receiveResult.addressManager,
						receiveResult.state,
					),
				);
				setTrackedAddresses(receiveResult.addressManager.getAddresses());
				setLastRotationOutpoint(receiveState.lastRotationOutpoint ?? null);
				receiveStateRef.current = receiveResult.state;
				addressManagerRef.current = receiveResult.addressManager;
				saveReceiveAddressState(
					{ chain, identityKey: newIdentityKey },
					receiveResult.state,
				);
				seenOutpointsRef.current = new Set();
				rotatingOutpointsRef.current = new Set();

				setIsInitialized(true);
				setInitError(null);
				persistBuiltInConnection();

				return {
					wallet: result.wallet,
					services: result.services,
					oneSatContext: createWalletContext(result.wallet, {
						services: result.services,
						chain,
						builtIn: true,
					}),
				};
			} catch (error) {
				for (const module of pendingPermissionModules) module.dispose();
				await pendingResult?.destroy();
				if (generation !== connectionGenerationRef.current) return null;
				reportFailure(
					{
						category: "provider",
						code: "provider.failed",
						operation: "wallet.initialize",
						recoverable: true,
						context: { mode: "built-in", retryable: true },
					},
					error,
				);
				setInitError(
					isRateLimited(error)
						? "The wallet server is busy (too many requests). Wait a minute, then lock and unlock the wallet."
						: "Built-in wallet initialization failed. Lock and unlock the wallet, then try again.",
				);
				setConnectionStatus("disconnected");
				setIsInitialized(false);
				setAddressManagerReady(false);
				initGuardRef.current = false;
				return null;
			} finally {
				if (generation === connectionGenerationRef.current) {
					setIsInitializing(false);
				}
			}
		},
		// guard state lives in initGuardRef so this callback keeps a stable
		// identity — its churn re-fired the WalletBridge init effect
		[chain],
	);

	// -- Wallet destroy --
	const destroyWallet = useCallback(async () => {
		// A teardown already under way (an external wallet disconnecting) may
		// keep the built-in wallet; wait it out, then destroy the local wallet.
		while (teardownPromiseRef.current) await teardownPromiseRef.current;
		await teardownWallet("disconnected");
	}, [teardownWallet]);

	const disconnectExternalWallet = useCallback(async () => {
		if (connectionMode !== "external") return;
		await teardownWallet("disconnected", { destroyLocal: false });
	}, [connectionMode, teardownWallet]);

	const switchWallet = useCallback(
		async (option: WalletConnectionOption): Promise<boolean> => {
			setExternalHop(null);
			if (option === "embedded") {
				const local = walletResultRef.current;
				const localPermissions = localPermissionsRef.current;
				const localReceive = localReceiveRef.current;
				if (!local || !localPermissions || !localReceive) {
					if (!local && hasBuiltInWallet) {
						// Not running here (the page opened in external mode, or the
						// external wallet is on the other chain): close the external
						// session; the chain returns to the account's network and the
						// bridge opens the built-in wallet there once it is unlocked.
						await teardownWallet("disconnected", { destroyLocal: false });
						return true;
					}
					setInitError(
						"Create or import a built-in wallet before switching back. The current wallet is unchanged.",
					);
					return false;
				}
				const session = walletSessionRef.current;
				walletSessionRef.current = null;
				walletSessionCleanupRef.current();
				walletSessionCleanupRef.current = () => {};
				if (session?.status === "connected") session.disconnect("manual");
				else session?.stop();
				externalServicesRef.current?.close();
				externalServicesRef.current = null;
				setWallet(local.wallet);
				setServices(local.services);
				setPermissionsManager(localPermissions.manager);
				setColorOverlay(localPermissions.colorOverlay);
				const { addressManager, state } = localReceive;
				addressManagerRef.current = addressManager;
				receiveStateRef.current = state;
				setIdentityKey(localReceive.identityKey);
				setReceiveAddressIndex(state.currentIndex);
				setDepositAddress(getDepositAddress(addressManager, state) || null);
				setReceiveAddresses(getActiveReceiveAddresses(addressManager, state));
				setTrackedAddresses(addressManager.getAddresses());
				setLastRotationOutpoint(state.lastRotationOutpoint ?? null);
				setAddressManagerReady(true);
				setConnectionMode("built-in");
				setProviderType("1sat-web");
				setConnectionStatus("ready");
				setIsInitialized(true);
				setInitError(null);
				persistBuiltInConnection();
				return true;
			}

			setIsInitializing(true);
			try {
				const result = await prepareWalletSwitch(option);
				// The external wallet's network becomes the active chain.
				const reported = await externalWalletChain(result.wallet);
				if ("error" in reported) {
					result.disconnect();
					setInitError(`${reported.error} The current wallet is unchanged.`);
					return false;
				}
				if (reported.chain !== chain) {
					// Reconnect on the wallet's chain: the store change remounts this
					// provider there, and its auto-reconnect connects again.
					result.disconnect();
					setExternalHop("switch");
					persistExternalConnection(reported.chain, option);
					return false;
				}
				const externalServices = createStackServices(chain);
				let addresses: string[];
				try {
					addresses = await deriveExternalAddresses(
						result.wallet,
						externalServices,
					);
				} catch (error) {
					externalServices.close();
					result.disconnect();
					throw error;
				}

				const session = walletSessionRef.current;
				walletSessionCleanupRef.current();
				walletSessionCleanupRef.current = () => {};
				walletSessionRef.current = null;
				if (session?.status === "connected") session.disconnect("manual");
				else session?.stop();
				externalServicesRef.current?.close();
				externalServicesRef.current = externalServices;

				setWallet(result.wallet);
				setServices(externalServices);
				setPermissionsManager(null);
				setIdentityKey(result.identityKey);
				setDepositAddress(addresses[0] ?? null);
				setReceiveAddresses(addresses);
				setTrackedAddresses(addresses);
				setAddressManagerReady(false);
				setConnectionMode("external");
				setConnectionStatus("ready");
				setProviderType(result.provider);
				setIsInitialized(true);
				setInitError(null);
				setExternalHop(null);
				persistExternalConnection(chain, option);

				const nextSession = createWalletSession(result);
				walletSessionRef.current = nextSession;
				const unsubscribeIdentity = nextSession.on(
					"identityChange",
					({ next }) => {
						if (walletSessionRef.current !== nextSession) return;
						setIdentityKey(next);
					},
				);
				const unsubscribeDisconnected = nextSession.on(
					"disconnected",
					({ reason }) => {
						if (walletSessionRef.current !== nextSession) return;
						void teardownWallet(statusAfterDisconnect(reason), {
							destroyLocal: false,
						});
					},
				);
				walletSessionCleanupRef.current = () => {
					unsubscribeIdentity();
					unsubscribeDisconnected();
				};
				nextSession.start();
				return true;
			} catch {
				reportDiagnostic({
					category: "provider",
					code: "provider.failed",
					operation: "wallet.switch",
					recoverable: true,
					context: { mode: "external", retryable: true },
				});
				setInitError("Wallet switch failed. The current wallet is unchanged.");
				return false;
			} finally {
				setIsInitializing(false);
			}
		},
		[chain, deriveExternalAddresses, hasBuiltInWallet, teardownWallet],
	);

	// Unmount (including a remount on another chain) waits out a teardown
	// already under way, then closes the wallet but keeps the persisted
	// connection, which decides the chain the next mount uses.
	const unmountWallet = useCallback(async () => {
		while (teardownPromiseRef.current) await teardownPromiseRef.current;
		await teardownWallet("disconnected", { keepConnection: true });
	}, [teardownWallet]);
	useEffect(() => () => void unmountWallet(), [unmountWallet]);

	// -- Compose sync status with init state --
	const syncStatus = useMemo<SyncStatus>(() => {
		const completed = Object.values(syncTasks)
			.map(({ lastRunAt }) => lastRunAt)
			.filter((timestamp): timestamp is number => timestamp !== null);
		const taskError = Object.values(syncTasks).find(
			({ error }) => error !== null,
		)?.error;
		return {
			isSyncing:
				isInitializing || balanceSyncStatus.isSyncing || syncEngineActive,
			progress: null,
			lastSync:
				completed.length > 0
					? new Date(Math.max(...completed))
					: balanceSyncStatus.lastSync,
			error: initError ?? taskError ?? balanceSyncStatus.error,
		};
	}, [
		isInitializing,
		balanceSyncStatus,
		initError,
		syncEngineActive,
		syncTasks,
	]);

	const hasActiveSync =
		isInitializing || balanceSyncStatus.isSyncing || syncEngineActive;

	// -- Context value --
	const value = useMemo<WalletToolboxContextValue>(
		() => ({
			wallet,
			permissionsManager,
			services,
			connectionMode,
			connectionStatus,
			providerType,
			isInitialized,
			isInitializing,
			initError,
			reportInitFailure,
			chain,
			identityKey,
			depositAddress,
			receiveAddressIndex,
			receiveAddresses,
			addressManagerReady,
			lastRotationOutpoint,
			syncStatus,
			syncTasks,
			syncWallet: syncWallet,
			syncEvents: syncEvents,
			clearSyncEvents: clearSyncEvents,
			walletEvents: walletEvents,
			clearWalletEvents: clearWalletEvents,
			hasActiveSync,
			oneSatContext,
			colorContext,
			colorOverlay: colorContext ? colorOverlay : null,
			balance: balance,
			ordinals: ordinals,
			bsv20Tokens: [],
			bsv21Tokens: bsv21Balances,
			legacyBalance,
			legacyFundingUtxos,
			isBalanceLoading: isBalanceLoading,
			balanceError: balanceError,
			ordinalsState,
			bsv21State,
			exchangeRate,
			initializeWallet,
			connectExternalWallet,
			switchWallet,
			disconnectExternalWallet,
			destroyWallet,
			refreshBalance: refreshBalance,
		}),
		[
			wallet,
			permissionsManager,
			services,
			connectionMode,
			connectionStatus,
			providerType,
			isInitialized,
			isInitializing,
			initError,
			reportInitFailure,
			chain,
			identityKey,
			depositAddress,
			receiveAddressIndex,
			receiveAddresses,
			addressManagerReady,
			lastRotationOutpoint,
			syncStatus,
			syncTasks,
			syncWallet,
			syncEvents,
			clearSyncEvents,
			walletEvents,
			clearWalletEvents,
			hasActiveSync,
			oneSatContext,
			colorContext,
			colorOverlay,
			balance,
			ordinals,
			bsv21Balances,
			legacyBalance,
			legacyFundingUtxos,
			isBalanceLoading,
			balanceError,
			ordinalsState,
			bsv21State,
			exchangeRate,
			initializeWallet,
			connectExternalWallet,
			switchWallet,
			disconnectExternalWallet,
			destroyWallet,
			refreshBalance,
		],
	);

	return (
		<WalletToolboxContext.Provider value={value}>
			{children}
		</WalletToolboxContext.Provider>
	);
}

export type {
	PermissionEventHandler,
	PermissionRequest,
} from "@bsv/wallet-toolbox-client";

export function useWalletToolbox() {
	const context = useContext(WalletToolboxContext);
	if (context === undefined) {
		throw new Error(
			"useWalletToolbox must be used within a WalletToolboxProvider",
		);
	}
	return context;
}
