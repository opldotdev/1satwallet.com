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

/** window key where the init script records failed DOM removals. */
export const DOM_MISSES_KEY = "__e2eDomMisses";

/**
 * Records every removeChild call whose node isn't a child of the parent (the
 * cause of React's "NotFoundError: removeChild"), with both nodes described,
 * so a production build still names the element React was removing.
 */
const domMissRecorder = `
(() => {
	const misses = [];
	Object.defineProperty(window, ${JSON.stringify(DOM_MISSES_KEY)}, { value: misses });
	const describe = (node) => {
		if (!node) return String(node);
		if (node.nodeType === 1) {
			const cls = (node.getAttribute("class") ?? "").split(/\\s+/).filter(Boolean).slice(0, 5).join(".");
			const testId = node.getAttribute("data-testid");
			return "<" + node.tagName.toLowerCase() + (node.id ? "#" + node.id : "") + (cls ? "." + cls : "") + (testId ? "[data-testid=" + testId + "]" : "") + ">";
		}
		if (node.nodeType === 3) return "#text " + JSON.stringify((node.textContent ?? "").slice(0, 40));
		if (node.nodeType === 8) return "<!--" + (node.data ?? "").slice(0, 20) + "-->";
		return node.nodeName;
	};
	const ancestry = (node) => {
		const chain = [];
		for (let at = node; at && chain.length < 5; at = at.parentNode) chain.push(describe(at));
		return chain.join(" < ");
	};
	const native = Node.prototype.removeChild;
	Node.prototype.removeChild = function (child) {
		if (child && child.parentNode !== this) {
			misses.push({
				parent: ancestry(this),
				child: describe(child),
				childParent: ancestry(child.parentNode),
				stack: (new Error().stack ?? "").split("\\n").slice(1, 8).join("\\n"),
			});
		}
		return native.call(this, child);
	};
})();
`;

/** For a fresh visitor: records request hosts and failed DOM removals. */
export function visitorInitScript(origin: string): string {
	return `${hostRecorder(origin)}\n${domMissRecorder}`;
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
