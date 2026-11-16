import type { Chain } from "@/lib/chain-endpoints";
import { WALLET_STORAGE_KEY } from "@/lib/constants";

/*
 * The active chain belongs to the account, not to a setting: the external
 * wallet's network while an external session is persisted, else the stored
 * built-in account's network, else mainnet.
 */

/**
 * Cookie mirror of the active chain, so the proxy can serve the testnet notice
 * for mainnet-only pages before they render. Present only while on testnet.
 */
export const WALLET_CHAIN_COOKIE = "1sat-wallet-chain";
/** The old global network setting. Read once by the migration, then removed. */
export const LEGACY_WALLET_CHAIN_KEY = "1sat-wallet-chain";
/** The network the persisted external session reported ("main" | "test"). */
export const EXTERNAL_NETWORK_KEY = "1sat-wallet-external-network";
export const WALLET_CONNECTION_MODE_KEY = "1sat-wallet-connection-mode";
const WALLET_CHAIN_EVENT = "1sat-wallet-chain-change";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 400;

type ReadStorage = Pick<Storage, "getItem">;
type ChainStorage = Pick<Storage, "getItem" | "removeItem">;
type CookieJar = { cookie: string };

export const parseWalletChain = (value: unknown): Chain =>
	value === "test" ? "test" : "main";

function getItem(storage: ReadStorage | undefined, key: string): string | null {
	try {
		return storage?.getItem(key) ?? null;
	} catch (error) {
		console.error(`[wallet-chain] could not read ${key}`, error);
		return null;
	}
}

/**
 * The network of a stored wallet envelope: null when there is no wallet or it
 * cannot be read, "test" only for an explicit testnet account. Never throws.
 */
export function accountNetworkOf(raw: string | null | undefined): Chain | null {
	if (!raw) return null;
	let envelope: unknown;
	try {
		envelope = JSON.parse(raw);
	} catch (error) {
		// The envelope holds only ciphertext and the salt's public key, so the
		// parse error carries no key material.
		console.error(
			"[wallet-chain] the stored wallet envelope is not JSON",
			error,
		);
		return null;
	}
	if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
		return null;
	}
	return (envelope as { network?: unknown }).network === "test"
		? "test"
		: "main";
}

/** A storage event that replaces or removes the wallet: its key, or clear(). */
export const isWalletStorageEvent = (key: string | null): boolean =>
	key === null || key === WALLET_STORAGE_KEY;

/**
 * Whether a wallet is stored after a storage event; undefined when the event
 * does not touch the wallet. clear() in another tab (key null) carries no
 * value, so storage is read again.
 */
export function walletStoredAfter(
	event: { key: string | null; newValue: string | null },
	storage: ReadStorage | undefined,
): boolean | undefined {
	if (!isWalletStorageEvent(event.key)) return undefined;
	if (event.key === WALLET_STORAGE_KEY) return !!event.newValue;
	return !!getItem(storage, WALLET_STORAGE_KEY);
}

export function resolveActiveChain(storage: ReadStorage | undefined): Chain {
	if (getItem(storage, WALLET_CONNECTION_MODE_KEY) === "external") {
		const external = getItem(storage, EXTERNAL_NETWORK_KEY);
		if (external === "main" || external === "test") return external;
	}
	return accountNetworkOf(getItem(storage, WALLET_STORAGE_KEY)) ?? "main";
}

/**
 * Everyone who had the old global setting becomes a mainnet account: the
 * envelope is left as it is (no network field means mainnet) and the key is
 * removed, so this runs once.
 */
export function migrateLegacyWalletChain(storage: ChainStorage | undefined): {
	wasTestnet: boolean;
} {
	const legacy = getItem(storage, LEGACY_WALLET_CHAIN_KEY);
	if (legacy === null) return { wasTestnet: false };
	try {
		storage?.removeItem(LEGACY_WALLET_CHAIN_KEY);
	} catch (error) {
		// The key is never read for anything else, so a leftover is harmless.
		console.error("[wallet-chain] could not remove the legacy key", error);
	}
	return { wasTestnet: legacy === "test" };
}

/** Sets the cookie on testnet and deletes it on mainnet, writing only on a change. */
export function syncWalletChainCookie(
	chain: Chain,
	jar: CookieJar | undefined,
): void {
	if (!jar) return;
	try {
		const current = jar.cookie
			.split(";")
			.map((part) => part.trim())
			.find((part) => part.startsWith(`${WALLET_CHAIN_COOKIE}=`))
			?.slice(WALLET_CHAIN_COOKIE.length + 1);
		if (chain === "test") {
			if (current === "test") return;
			jar.cookie = `${WALLET_CHAIN_COOKIE}=test; path=/; SameSite=Lax; max-age=${COOKIE_MAX_AGE}`;
		} else if (current !== undefined) {
			jar.cookie = `${WALLET_CHAIN_COOKIE}=; path=/; SameSite=Lax; max-age=0`;
		}
	} catch (error) {
		// Cookies blocked: the client guard still hides mainnet-only pages.
		console.error("[wallet-chain] could not sync the chain cookie", error);
	}
}

export interface WalletChainEnvironment {
	storage: () => ChainStorage | undefined;
	cookies: () => CookieJar | undefined;
	/** The window; undefined on the server. */
	events: () => EventTarget | undefined;
}

export interface WalletChainStore {
	read(): Chain;
	refresh(): void;
	subscribe(listener: () => void): () => void;
	/**
	 * True once, after the migration found the old testnet setting and a
	 * built-in wallet is stored.
	 */
	takeLegacyTestnetNotice(): boolean;
}

/**
 * The active chain as a cached store, so useSyncExternalStore gets a stable
 * snapshot. The first client read migrates the legacy key and starts listening
 * for the wallet being replaced or removed, in this tab or another one. A
 * connection change made in another tab applies on that tab's next load, never
 * mid-session.
 */
export function createWalletChainStore(
	env: WalletChainEnvironment,
): WalletChainStore {
	let current: Chain | undefined;
	let legacyTestnet = false;

	function compute(): Chain {
		const chain = resolveActiveChain(env.storage());
		syncWalletChainCookie(chain, env.cookies());
		return chain;
	}

	function read(): Chain {
		if (current !== undefined) return current;
		const events = env.events();
		if (!events) return "main";
		legacyTestnet = migrateLegacyWalletChain(env.storage()).wasTestnet;
		current = compute();
		events.addEventListener("storage", (event) => {
			if (isWalletStorageEvent((event as StorageEvent).key)) refresh();
		});
		return current;
	}

	function refresh(): void {
		const events = env.events();
		if (!events) return;
		if (current === undefined) {
			read();
			return;
		}
		const next = compute();
		if (next === current) return;
		current = next;
		events.dispatchEvent(new Event(WALLET_CHAIN_EVENT));
	}

	return {
		read,
		refresh,
		subscribe(listener) {
			const events = env.events();
			if (!events) return () => {};
			events.addEventListener(WALLET_CHAIN_EVENT, listener);
			return () => events.removeEventListener(WALLET_CHAIN_EVENT, listener);
		},
		takeLegacyTestnetNotice() {
			read();
			// Only a stored built-in account was moved to mainnet; with no wallet
			// there is nothing to tell.
			const show =
				legacyTestnet && getItem(env.storage(), WALLET_STORAGE_KEY) !== null;
			legacyTestnet = false;
			return show;
		},
	};
}

function browserStorage(): ChainStorage | undefined {
	try {
		return typeof window === "undefined" ? undefined : window.localStorage;
	} catch (error) {
		console.error("[wallet-chain] localStorage is blocked", error);
		return undefined;
	}
}

const store = createWalletChainStore({
	storage: browserStorage,
	cookies: () => (typeof document === "undefined" ? undefined : document),
	events: () => (typeof window === "undefined" ? undefined : window),
});

/** The stored built-in account's network; null with no readable wallet. */
export const storedAccountNetwork = (): Chain | null =>
	accountNetworkOf(getItem(browserStorage(), WALLET_STORAGE_KEY));
/** The active account's chain. Mainnet on the server. */
export const readWalletChain = (): Chain => store.read();
/** Recomputes the active chain and notifies subscribers if it changed. */
export const refreshWalletChain = (): void => store.refresh();
/** Fires when the active chain changes. */
export const subscribeWalletChain = (listener: () => void): (() => void) =>
	store.subscribe(listener);
/** True once per page load, after the old testnet setting was migrated for a stored wallet. */
export const takeLegacyTestnetNotice = (): boolean =>
	store.takeLegacyTestnetNotice();
