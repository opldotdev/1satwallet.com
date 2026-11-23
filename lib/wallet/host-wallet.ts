/**
 * Detects a page opened inside a wallet app's own browser, such as the
 * Metanet mobile browser (bsv-browser). Such an app binds two things to every
 * page before it runs: its native message bridge (window.ReactNativeWebView)
 * and a BRC-100 provider on top of it (window.CWI). A desktop browser with a
 * wallet extension has window.CWI but no native bridge, so it is not a host.
 */

/** Marks this tab session as having tried to connect the host wallet already. */
export const HOST_CONNECT_TRIED_KEY = "1sat-wallet-host-connect-tried";

type HostWindow = {
	CWI?: unknown;
	ReactNativeWebView?: { postMessage?: unknown };
};

export function isWalletAppBrowser(win?: HostWindow): boolean {
	const target =
		win ??
		(typeof window === "undefined"
			? undefined
			: (window as unknown as HostWindow));
	if (!target) return false;
	const bridge = target.ReactNativeWebView;
	return (
		typeof target.CWI === "object" &&
		target.CWI !== null &&
		typeof bridge === "object" &&
		bridge !== null &&
		typeof bridge.postMessage === "function"
	);
}

type SessionFlags = Pick<Storage, "getItem" | "setItem">;

function sessionFlags(storage?: SessionFlags): SessionFlags | null {
	if (storage) return storage;
	try {
		return window.sessionStorage;
	} catch (error) {
		console.warn(
			"[host-wallet] sessionStorage is not readable; connecting the wallet app once per page load",
			error instanceof Error ? error.message : String(error),
		);
		return null;
	}
}

let triedThisPageLoad = false;

/**
 * Whether to connect the wallet app on its own, without the user picking it:
 * only in a wallet app's browser, only with no wallet stored or chosen on this
 * device, and only once per tab session, so disconnecting or declining the
 * app's prompt leaves the user on the wallet picker.
 */
export function shouldConnectHostWallet(deps: {
	savedConnectionMode: string | null;
	hasStoredWallet: boolean;
	isHost?: boolean;
	storage?: SessionFlags;
}): boolean {
	if (deps.savedConnectionMode !== null || deps.hasStoredWallet) return false;
	if (!(deps.isHost ?? isWalletAppBrowser())) return false;
	const storage = sessionFlags(deps.storage);
	if (!storage) return !triedThisPageLoad;
	try {
		return storage.getItem(HOST_CONNECT_TRIED_KEY) === null;
	} catch (error) {
		console.warn(
			"[host-wallet] could not read the connect-once flag",
			error instanceof Error ? error.message : String(error),
		);
		return !triedThisPageLoad;
	}
}

export function markHostWalletConnectTried(storage?: SessionFlags): void {
	triedThisPageLoad = true;
	const flags = sessionFlags(storage);
	if (!flags) return;
	try {
		flags.setItem(HOST_CONNECT_TRIED_KEY, "1");
	} catch (error) {
		console.warn(
			"[host-wallet] could not save the connect-once flag",
			error instanceof Error ? error.message : String(error),
		);
	}
}
