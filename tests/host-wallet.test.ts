import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	HOST_CONNECT_TRIED_KEY,
	isWalletAppBrowser,
	markHostWalletConnectTried,
	shouldConnectHostWallet,
} from "@/lib/wallet/host-wallet";

const bridge = { postMessage: () => {} };

function memoryStorage() {
	const items = new Map<string, string>();
	return {
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => {
			items.set(key, value);
		},
	};
}

describe("isWalletAppBrowser", () => {
	it("is true when a wallet app binds both its bridge and window.CWI", () => {
		assert.equal(
			isWalletAppBrowser({ CWI: {}, ReactNativeWebView: bridge }),
			true,
		);
	});

	it("is false for a desktop browser with only a wallet extension", () => {
		assert.equal(isWalletAppBrowser({ CWI: {} }), false);
	});

	it("is false for a native web view with no BRC-100 provider", () => {
		assert.equal(isWalletAppBrowser({ ReactNativeWebView: bridge }), false);
	});

	it("is false when the bridge cannot post messages", () => {
		assert.equal(
			isWalletAppBrowser({ CWI: {}, ReactNativeWebView: {} }),
			false,
		);
	});
});

describe("shouldConnectHostWallet", () => {
	const fresh = { savedConnectionMode: null, hasStoredWallet: false };

	it("connects a fresh visit in a wallet app once per tab session", () => {
		const storage = memoryStorage();
		assert.equal(
			shouldConnectHostWallet({ ...fresh, isHost: true, storage }),
			true,
		);
		markHostWalletConnectTried(storage);
		assert.equal(storage.getItem(HOST_CONNECT_TRIED_KEY), "1");
		assert.equal(
			shouldConnectHostWallet({ ...fresh, isHost: true, storage }),
			false,
		);
	});

	it("never connects outside a wallet app", () => {
		assert.equal(
			shouldConnectHostWallet({
				...fresh,
				isHost: false,
				storage: memoryStorage(),
			}),
			false,
		);
	});

	it("leaves a wallet stored on this device alone", () => {
		assert.equal(
			shouldConnectHostWallet({
				savedConnectionMode: null,
				hasStoredWallet: true,
				isHost: true,
				storage: memoryStorage(),
			}),
			false,
		);
	});

	it("leaves a connection the user already chose alone", () => {
		for (const savedConnectionMode of ["built-in", "external"]) {
			assert.equal(
				shouldConnectHostWallet({
					savedConnectionMode,
					hasStoredWallet: false,
					isHost: true,
					storage: memoryStorage(),
				}),
				false,
			);
		}
	});
});
