/**
 * The storage provider a built-in wallet uses as its active store, as chosen
 * on this browser. Kept per chain and identity key, because each account has
 * its own store. No entry means the hosted 1Sat storage.
 *
 * This is only where this browser looks first. The store's own user record
 * (`activeStorage`) decides which store the wallet writes to, so a move made
 * on another device is followed, never undone.
 */

export interface StorageChoiceStore {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

function choiceKey(chain: string, identityKey: string): string {
	return `1sat.walletStorage.${chain}.${identityKey}`;
}

function storeOf(store?: StorageChoiceStore): StorageChoiceStore | null {
	if (store) return store;
	if (typeof window === "undefined") return null;
	return window.localStorage;
}

/**
 * Normalizes a storage provider address the user typed. Throws when it is not
 * an https URL with a host; an `http://localhost` address is allowed for
 * development.
 */
export function normalizeStorageUrl(input: string): string {
	const trimmed = input.trim();
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error(
			"Enter the provider's full address, starting with https://",
		);
	}
	const local =
		url.protocol === "http:" &&
		(url.hostname === "localhost" || url.hostname === "127.0.0.1");
	if (url.protocol !== "https:" && !local) {
		throw new Error("The provider's address must start with https://");
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error("Enter the provider's address without a login or query");
	}
	return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/** The saved provider for this account, or null for the hosted default. */
export function loadStorageChoice(
	chain: string,
	identityKey: string,
	store?: StorageChoiceStore,
): string | null {
	const s = storeOf(store);
	if (!s) return null;
	const saved = s.getItem(choiceKey(chain, identityKey));
	if (!saved) return null;
	try {
		return normalizeStorageUrl(saved);
	} catch {
		return null;
	}
}

/**
 * Saves the provider for this account. Saving the hosted default, or null,
 * removes the entry.
 */
export function saveStorageChoice(
	chain: string,
	identityKey: string,
	url: string | null,
	defaultUrl: string,
	store?: StorageChoiceStore,
): void {
	const s = storeOf(store);
	if (!s) return;
	const key = choiceKey(chain, identityKey);
	const normalized = url === null ? null : normalizeStorageUrl(url);
	let defaultNormalized = defaultUrl;
	try {
		defaultNormalized = normalizeStorageUrl(defaultUrl);
	} catch {
		// A development default (plain http) still compares as written.
	}
	if (normalized === null || normalized === defaultNormalized) {
		s.removeItem(key);
	} else {
		s.setItem(key, normalized);
	}
}
