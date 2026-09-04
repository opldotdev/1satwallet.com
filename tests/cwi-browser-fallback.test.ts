import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
	type BridgeTransportState,
	CWIBridge,
	getCWIClient,
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
		const topLevel = {
			location: { search: "?origin=https%3A%2F%2Fapp.example" },
			opener,
		} as Window & typeof globalThis;
		topLevel.parent = topLevel;
		setGlobal("window", topLevel);
		setGlobal("document", { referrer: "" });
		assert.deepEqual(getCWIClient(), {
			window: opener,
			identity: {
				browserOrigin: "https://app.example",
				originator: "app.example",
			},
		});

		const parent = {} as WindowProxy;
		setGlobal("window", { parent, opener: null });
		setGlobal("document", { referrer: "https://embed.example/studio" });
		assert.deepEqual(getCWIClient(), {
			window: parent,
			identity: {
				browserOrigin: "https://embed.example",
				originator: "embed.example",
			},
		});
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

	test("accepts popup requests only from the declared origin and opener", () => {
		const opener = { postMessage() {} } as unknown as WindowProxy;
		const topLevel = {
			location: { search: "?origin=https%3A%2F%2Fapp.example" },
			opener,
		} as Window & typeof globalThis;
		topLevel.parent = topLevel;
		setGlobal("window", topLevel);
		setGlobal("document", { referrer: "" });

		const sent: unknown[] = [];
		const bridge = new CWIBridge({
			onStatusChange: () => {},
			onPermissionRequest: () => {},
		});
		const internals = bridge as unknown as {
			channel: { postMessage: (message: unknown) => void; close: () => void };
			leaderId: string;
			handleDAppMessage: (event: MessageEvent) => void;
		};
		internals.channel = {
			postMessage: (message) => sent.push(message),
			close() {},
		};
		internals.leaderId = "leader";
		const request = (source: object, origin: string) =>
			internals.handleDAppMessage({
				isTrusted: true,
				source,
				origin,
				data: {
					type: "CWI",
					isInvocation: true,
					id: crypto.randomUUID(),
					call: "getVersion",
					args: {},
				},
			} as unknown as MessageEvent);

		request({}, "https://app.example");
		request(opener, "https://evil.example");
		assert.equal(sent.length, 0);
		request(opener, "https://app.example");
		assert.equal(sent.length, 1);
		bridge.stop();
	});
});
