import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { PrivateKey } from "@bsv/sdk";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createElement, type ReactNode } from "react";

// The wallet home Send and Receive dialogs, mounted in a DOM with the wallet,
// the handle lookups and the send action stubbed, and the dialogs drawn in
// place (no portal), so each test is about what the user sees and sends.

const identityKey = PrivateKey.fromRandom().toPublicKey().toString();
const bobKey = PrivateKey.fromRandom().toPublicKey().toString();
const bob = {
	metanetHandles: "1.0",
	handle: "bob",
	domain: "example.com",
	identityKey: bobKey,
	certificate: { subject: bobKey },
	messagebox: "https://messagebox.example.com",
	ttl: 60,
	revoked: false,
};

const stubs = {
	toolbox: {
		chain: "main",
		connectionMode: "built-in",
		depositAddress: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
		identityKey: identityKey as string | null,
		wallet: {},
		oneSatContext: {
			wallet: {
				listActions: async () => ({ totalActions: 0, actions: [] }),
			},
		},
		refreshBalance: () => {},
	},
	handles: {
		isPending: false,
		isError: false,
		data: [
			{ handle: "me", domain: "1sat.app", certifier: "c", serialNumber: "s" },
		],
		refetch: async () => {},
	} as Record<string, unknown>,
	sent: [] as unknown[],
};

const Plain = ({ children }: { children?: ReactNode }) =>
	createElement("div", null, children);
const Pass = ({ children }: { children?: ReactNode }) =>
	createElement("span", null, children);
/** Dialogs drawn in place and always open. */
const plainDialog = {
	SoundDialog: Plain,
	DialogClose: Pass,
	DialogContent: Plain,
	DialogDescription: Plain,
	DialogFooter: Plain,
	DialogHeader: Plain,
	DialogOverlay: Plain,
	DialogPortal: Plain,
	DialogTitle: Plain,
	DialogTrigger: Pass,
};

type Restore = [string, Record<string, unknown>];

describe("wallet home Send and Receive", () => {
	let React: typeof import("react");
	let act: typeof import("react").act;
	let createRoot: typeof import("react-dom/client").createRoot;
	let WalletHomeActions: typeof import("@/components/wallet/wallet-home-actions").WalletHomeActions;
	let QueryClient: typeof import("@tanstack/react-query").QueryClient;
	let QueryClientProvider: typeof import("@tanstack/react-query").QueryClientProvider;
	const restore: Restore[] = [];

	before(async () => {
		GlobalRegistrator.register();
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		const { mock } = require("bun:test");
		const stub = async (
			path: string,
			make: (real: Record<string, unknown>) => Record<string, unknown>,
		) => {
			const real = { ...(await import(path)) };
			restore.push([path, real]);
			mock.module(path, () => make(real));
		};
		await stub("@1sat/actions", (real) => ({
			...real,
			resolvePaymentHandle: async () => bob,
			sendBsv: {
				...(real.sendBsv as object),
				execute: async (_ctx: unknown, input: unknown) => {
					stubs.sent.push(input);
					return { txid: "ab".repeat(32), delivered: "envelope" };
				},
			},
		}));
		await stub("@1sat/client", (real) => ({
			...real,
			resolveHandle: async () => bob,
		}));
		mock.module("@/providers/wallet-toolbox-provider", () => ({
			useWalletToolbox: () => stubs.toolbox,
		}));
		await stub("@/hooks/use-wallet-handles", (real) => ({
			...real,
			useWalletHandles: () => stubs.handles,
		}));
		await stub("@/hooks/use-sound", (real) => ({
			...real,
			useSound: () => ({ play() {}, preparePayChime() {} }),
		}));
		// Radix picks a no-op layout effect when it first loads without a DOM,
		// as it does when an earlier test file renders on the server; tab panels
		// then never mount. Give it the real one.
		const { useLayoutEffect } = await import("react");
		await stub("@radix-ui/react-use-layout-effect", (real) => ({
			...real,
			useLayoutEffect,
		}));
		await stub("@/components/ui/sound-dialog", (real) => ({
			...real,
			...plainDialog,
		}));
		React = await import("react");
		act = React.act;
		({ createRoot } = await import("react-dom/client"));
		({ QueryClient, QueryClientProvider } = await import(
			"@tanstack/react-query"
		));
		({ WalletHomeActions } = await import(
			"@/components/wallet/wallet-home-actions"
		));
	});

	after(async () => {
		const { mock } = require("bun:test");
		for (const [path, real] of restore) mock.module(path, () => real);
		delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		await GlobalRegistrator.unregister();
	});

	beforeEach(() => {
		document.body.innerHTML = "";
		stubs.sent.length = 0;
		stubs.toolbox.connectionMode = "built-in";
		stubs.toolbox.identityKey = identityKey;
	});

	const flush = async () => {
		for (let i = 0; i < 5; i++) {
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
		}
	};

	const mount = async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		await act(async () =>
			createRoot(container).render(
				React.createElement(
					QueryClientProvider,
					{ client },
					React.createElement(WalletHomeActions),
				),
			),
		);
		await flush();
		return container;
	};

	const button = (name: string) => {
		const found = Array.from(document.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === name,
		);
		assert.ok(found, `button "${name}" is on screen`);
		return found;
	};

	const type = async (id: string, value: string) => {
		const input = document.getElementById(id) as HTMLInputElement;
		assert.ok(input, `#${id} is on screen`);
		const setter = Object.getOwnPropertyDescriptor(
			Object.getPrototypeOf(input),
			"value",
		)?.set;
		await act(async () => {
			setter?.call(input, value);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
	};

	const press = async (el: Element) => {
		await act(async () => {
			el.dispatchEvent(
				new MouseEvent("mousedown", { bubbles: true, button: 0 }),
			);
			(el as HTMLElement).click();
		});
		await flush();
	};

	it("offers the address, the wallet's handles and its PeerPay link in the built-in wallet", async () => {
		await mount();
		const tabs = Array.from(document.querySelectorAll('[role="tab"]')).map(
			(t) => t.textContent,
		);
		assert.deepEqual(tabs, ["Address", "Handle", "PeerPay"]);

		await press(document.querySelectorAll('[role="tab"]')[1]);
		assert.match(document.body.textContent ?? "", /@me@1sat\.app/);

		await press(document.querySelectorAll('[role="tab"]')[2]);
		const key = document.querySelector(
			'input[aria-label="Identity key"]',
		) as HTMLInputElement;
		assert.equal(key.value, identityKey);
		assert.ok(
			document.querySelector(
				'[aria-label="QR code for this wallet\'s PeerPay link"]',
			),
		);
	});

	it("offers registration when the wallet holds no handle", async () => {
		stubs.handles = { ...stubs.handles, data: [] };
		await mount();
		await press(document.querySelectorAll('[role="tab"]')[1]);
		assert.ok(document.getElementById("register-handle-name"));
		const link = Array.from(document.querySelectorAll("a")).find((a) =>
			a.textContent?.includes("Register on the handle site"),
		);
		assert.equal(link?.getAttribute("href"), "https://accounts.1sat.app");
		stubs.handles = {
			...stubs.handles,
			data: [
				{ handle: "me", domain: "1sat.app", certifier: "c", serialNumber: "s" },
			],
		};
	});

	it("keeps an external wallet to its address", async () => {
		stubs.toolbox.connectionMode = "external";
		await mount();
		assert.equal(document.querySelectorAll('[role="tab"]').length, 0);
		assert.ok(document.querySelector('input[aria-label="Deposit address"]'));
	});

	it("asks for a memo only for a handle, shows the handle's key, and pays the handle typed", async () => {
		await mount();
		await type("wallet-home-recipient", "1BoatSLRHtKNngkdXEeobR76b53LETtpyT");
		assert.equal(document.getElementById("wallet-home-memo"), null);

		await type("wallet-home-recipient", "@Bob@Example.com");
		await type("wallet-home-amount", "0.0001");
		await type("wallet-home-memo", "lunch");
		await press(button("Review payment"));
		const text = document.body.textContent ?? "";
		assert.match(text, /@bob@example\.com/);
		assert.match(text, new RegExp(bobKey.slice(0, 10)));
		assert.match(text, /lunch/);

		await press(button("Confirm and send"));
		assert.deepEqual(stubs.sent, [
			{
				requests: [
					{ handle: "@bob@example.com", satoshis: 10_000, memo: "lunch" },
				],
			},
		]);
		assert.match(document.body.textContent ?? "", /Payment sent/);
	});
});
