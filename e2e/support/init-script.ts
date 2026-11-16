import { WALLET_STORAGE_KEY } from "@/lib/constants";
import { INSTALLATION_ID_KEY } from "@/lib/wallet-storage-identity";
import { E2E_INSTALLATION_ID } from "./env";

/** sessionStorage key where the init script records request hosts. */
export const HOSTS_KEY = "1sat-e2e-hosts";

/** Records the host of every request the app's own pages make. */
const hostRecorder = (origin: string) => `
if (location.origin === ${JSON.stringify(origin)}) {
	const record = (url) => {
		try {
			const host = new URL(url, location.href).host;
			const hosts = JSON.parse(sessionStorage.getItem(${JSON.stringify(HOSTS_KEY)}) ?? "[]");
			if (!hosts.includes(host)) {
				hosts.push(host);
				sessionStorage.setItem(${JSON.stringify(HOSTS_KEY)}, JSON.stringify(hosts));
			}
		} catch (error) {
			console.error("1sat e2e: could not record a request host", error);
		}
	};
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) record(entry.name);
	}).observe({ type: "resource", buffered: true });
}
`;

/** For a fresh visitor: only records request hosts. */
export function visitorInitScript(origin: string): string {
	return hostRecorder(origin);
}

/**
 * For a wallet session. Seeds the encrypted backup into localStorage once per
 * tab, and holds the passphrase in a closure that only the app's origin can
 * reach: `__e2eEnterPassphrase()` types it into the unlock screen without it
 * ever crossing the agent-browser command line, and
 * `__e2eForgetPassphrase()` drops it for the rest of the document.
 */
export function walletInitScript(
	origin: string,
	wallet: { backup: string; passphrase: string },
): string {
	return `${hostRecorder(origin)}
if (location.origin === ${JSON.stringify(origin)}) {
	if (!sessionStorage.getItem("1sat-e2e-seeded")) {
		localStorage.setItem(${JSON.stringify(WALLET_STORAGE_KEY)}, ${JSON.stringify(wallet.backup)});
		localStorage.setItem(${JSON.stringify(INSTALLATION_ID_KEY)}, ${JSON.stringify(E2E_INSTALLATION_ID)});
		sessionStorage.setItem("1sat-e2e-seeded", "1");
	}
	let passphrase = ${JSON.stringify(wallet.passphrase)};
	Object.defineProperty(window, "__e2eEnterPassphrase", {
		configurable: true,
		value: () => {
			const input = document.querySelector('[role="dialog"][aria-label="Unlock wallet"] #passphrase');
			if (!(input instanceof HTMLInputElement) || !passphrase) return false;
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, passphrase);
			input.dispatchEvent(new Event("input", { bubbles: true }));
			return true;
		},
	});
	Object.defineProperty(window, "__e2eForgetPassphrase", {
		configurable: true,
		value: () => {
			passphrase = "";
			delete window.__e2eEnterPassphrase;
			delete window.__e2eForgetPassphrase;
		},
	});
}
`;
}
