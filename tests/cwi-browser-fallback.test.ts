import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
	type BridgeTransportState,
	CWIBridge,
	getCWIClientWindow,
} from "../lib/cwi/bridge";

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;

const setGlobal = (name: "window" | "document", value: unknown): void => {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		writable: true,
		value,
	});
};

afterEach(() => {
	setGlobal("window", originalWindow);
	setGlobal("document", originalDocument);
});

describe("hosted CWI browser fallback", () => {
	test("uses the opener for a top-level bridge and the parent for an embed", () => {
		const opener = {} as WindowProxy;
		const topLevel = { opener } as Window & typeof globalThis;
		topLevel.parent = topLevel;
		setGlobal("window", topLevel);
		assert.equal(getCWIClientWindow(), opener);

		const parent = {} as WindowProxy;
		setGlobal("window", { parent, opener: null });
		assert.equal(getCWIClientWindow(), parent);
	});

	test("recommends fallback when an embed cannot request storage access", () => {
		let transportState: BridgeTransportState | undefined;
		const parent = {} as WindowProxy;
		setGlobal("window", {
			addEventListener: () => {},
			removeEventListener: () => {},
			parent,
			self: {},
			top: parent,
		});
		setGlobal("document", { referrer: "https://app.example" });

		const bridge = new CWIBridge({
			onStatusChange: () => {},
			onPermissionRequest: () => {},
			onTransportStateChange: (state) => {
				transportState = state;
			},
		});
		bridge.start();
		assert.deepEqual(transportState, {
			transport: "embed",
			fallbackRecommended: true,
			reason: "channel_unavailable",
		});
		bridge.stop();
	});
});
