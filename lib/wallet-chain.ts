import type { Chain } from "@/lib/chain-endpoints";

/** The network the built-in wallet runs on. One setting for the whole wallet. */
export const WALLET_CHAIN_KEY = "1sat-wallet-chain";
/**
 * Cookie mirror of the setting, so the proxy can serve the testnet notice for
 * mainnet-only pages before they render. Present only while on testnet.
 */
export const WALLET_CHAIN_COOKIE = "1sat-wallet-chain";
const WALLET_CHAIN_EVENT = "1sat-wallet-chain-change";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 400;

type ChainStorage = Pick<Storage, "getItem" | "setItem">;
type CookieJar = { cookie: string };

function browserStorage(): ChainStorage | undefined {
	try {
		return typeof window === "undefined" ? undefined : window.localStorage;
	} catch {
		return undefined;
	}
}

const browserCookies = (): CookieJar | undefined =>
	typeof document === "undefined" ? undefined : document;

export const parseWalletChain = (value: unknown): Chain =>
	value === "test" ? "test" : "main";

/** Sets the cookie on testnet and deletes it on mainnet, writing only on a change. */
export function syncWalletChainCookie(
	chain: Chain,
	jar: CookieJar | undefined = browserCookies(),
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
	} catch {
		// Cookies blocked: the client guard still hides mainnet-only pages.
	}
}

export function readWalletChain(
	storage: ChainStorage | undefined = browserStorage(),
	jar: CookieJar | undefined = browserCookies(),
): Chain {
	let chain: Chain = "main";
	try {
		chain = parseWalletChain(storage?.getItem(WALLET_CHAIN_KEY));
	} catch {
		chain = "main";
	}
	syncWalletChainCookie(chain, jar);
	return chain;
}

export function writeWalletChain(
	chain: Chain,
	storage: ChainStorage | undefined = browserStorage(),
	jar: CookieJar | undefined = browserCookies(),
): void {
	const next = parseWalletChain(chain);
	storage?.setItem(WALLET_CHAIN_KEY, next);
	syncWalletChainCookie(next, jar);
	if (typeof window !== "undefined") {
		window.dispatchEvent(new Event(WALLET_CHAIN_EVENT));
	}
}

/** Fires on a change in this tab or another one. */
export function subscribeWalletChain(listener: () => void): () => void {
	if (typeof window === "undefined") return () => {};
	const onStorage = (event: StorageEvent) => {
		if (event.key === null || event.key === WALLET_CHAIN_KEY) listener();
	};
	window.addEventListener("storage", onStorage);
	window.addEventListener(WALLET_CHAIN_EVENT, listener);
	return () => {
		window.removeEventListener("storage", onStorage);
		window.removeEventListener(WALLET_CHAIN_EVENT, listener);
	};
}
