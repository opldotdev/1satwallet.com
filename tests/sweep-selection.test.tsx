import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createElement, type ReactNode } from "react";

// The migrate page and the first-run wizard both pick ordinals through
// useLegacyAssets and useDefaultOrdinalSelection. These tests mount the real
// page in a DOM with the wallet, the scan and the router stubbed, so a list
// rebuilt on every render (an endless re-render that undid every deselect,
// and starved every other page of the main thread) shows up here.

const outpoint = (n: number) => `${String(n).padStart(64, "a")}_0`;
const scanFixture = {
	funding: [],
	ordinals: [0, 1].map((n) => ({
		outpoint: outpoint(n),
		satoshis: 1,
		events: ["type:image/png"],
	})),
	opnsNames: [],
	bsv21Tokens: [],
	bsv20Tokens: [],
	listings: [],
	locked: [],
	run: [],
	totalFundingSats: 0,
};

const stubs = {
	walletKeys: { stub: true } as Record<string, unknown> | null,
	toolbox: {
		chain: "main",
		connectionMode: "local",
		ordinals: [] as unknown[],
		isBalanceLoading: false,
		isInitialized: true,
		oneSatContext: null,
		destroyWallet: async () => {},
		initializeWallet: async () => {},
		refreshBalance: async () => {},
	},
};

type Restore = [string, Record<string, unknown>];

/** Hooks load after the DOM is in place, so the host reads them here. */
const loaded: {
	useLegacyAssets?: typeof import("@/lib/hooks/use-legacy-assets").useLegacyAssets;
	useDefaultOrdinalSelection?: typeof import("@/lib/hooks/use-default-ordinal-selection").useDefaultOrdinalSelection;
	renders: number;
	/** Each distinct ordinals list the host saw. */
	lists: Set<unknown>;
} = { renders: 0, lists: new Set() };

/** The two hooks every sweep host runs, before any wallet is unlocked. */
function SelectionHost() {
	loaded.renders++;
	const { useLegacyAssets, useDefaultOrdinalSelection } = loaded;
	if (!useLegacyAssets || !useDefaultOrdinalSelection) {
		throw new Error("hooks not loaded");
	}
	const assets = useLegacyAssets(null, null, null);
	loaded.lists.add(assets.ordinals);
	const [selected] = useDefaultOrdinalSelection(assets.ordinals);
	return createElement("p", null, String(selected.size));
}

const Plain = ({ children }: { children?: ReactNode }) =>
	createElement("div", null, children);

/** A sheet with no portal or animation: open shows its children. */
const plainSheet = {
	Sheet: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
		open ? createElement("div", null, children) : null,
	SheetContent: Plain,
	SheetHeader: Plain,
	SheetFooter: Plain,
	SheetTitle: Plain,
	SheetDescription: Plain,
};

describe("sweep ordinal selection in a host", () => {
	let React: typeof import("react");
	let act: typeof import("react").act;
	let createRoot: typeof import("react-dom/client").createRoot;
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
		// No test imports the providers themselves (they reach the network
		// when loaded), so these stubs replace them outright.
		const replace = (path: string, exports: Record<string, unknown>) =>
			mock.module(path, () => exports);
		await stub("@1sat/actions", (real) => ({
			...real,
			scanAddresses: async () => scanFixture,
			// Scanned one address at a time: the fixture sits on the ord
			// address only, as the indexer would report it.
			scanAddress: async (_services: unknown, address: string) =>
				address === "stub-ord-address"
					? scanFixture
					: { ...scanFixture, ordinals: [] },
		}));
		await stub("@/lib/wallet-migration", (real) => ({
			...real,
			detectMigrationStatus: () => ({
				status: "legacy",
				legacyPayWif: "stub-pay",
				legacyOrdWif: "stub-ord",
				legacyPayAddress: "stub-pay-address",
				legacyOrdAddress: "stub-ord-address",
			}),
		}));
		replace("@/providers/wallet-provider", {
			useWallet: () => ({
				walletKeys: stubs.walletKeys,
				isWalletLocked: false,
			}),
		});
		replace("@/providers/wallet-toolbox-provider", {
			useWalletToolbox: () => stubs.toolbox,
		});
		await stub("next/navigation", (real) => ({
			...real,
			useRouter: () => ({ push() {}, replace() {}, back() {} }),
		}));
		React = await import("react");
		act = React.act;
		({ createRoot } = await import("react-dom/client"));
		// Radix picks its layout effect when first loaded, and the server
		// render tests may load it with no DOM, so the sheet never opens
		// here. A plain sheet keeps this test about the host's state.
		await stub("@/components/ui/sheet", (real) => ({
			...real,
			...plainSheet,
		}));
	});

	after(async () => {
		const { mock } = require("bun:test");
		for (const [path, real] of restore) mock.module(path, () => real);
		delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		await GlobalRegistrator.unregister();
	});

	const flush = async () => {
		for (let i = 0; i < 5; i++) {
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
		}
	};

	const button = (name: string) => {
		const found = Array.from(document.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === name,
		);
		assert.ok(
			found,
			`button "${name}" is on screen; buttons: ${Array.from(
				document.querySelectorAll("button"),
			)
				.map((b) => b.textContent?.trim())
				.join(", ")}`,
		);
		return found;
	};

	it("settles with no legacy addresses instead of re-rendering forever", async () => {
		const { useLegacyAssets } = await import("@/lib/hooks/use-legacy-assets");
		const { useDefaultOrdinalSelection } = await import(
			"@/lib/hooks/use-default-ordinal-selection"
		);
		loaded.useLegacyAssets = useLegacyAssets;
		loaded.useDefaultOrdinalSelection = useDefaultOrdinalSelection;
		loaded.renders = 0;
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		await act(async () => root.render(React.createElement(SelectionHost)));
		await flush();
		const settled = loaded.renders;
		await flush();
		assert.equal(loaded.renders, settled, "no renders once settled");
		assert.ok(settled <= 4, `settled in ${settled} renders`);
		// A parent re-render hands back the same lists, not new ones.
		await act(async () => root.render(React.createElement(SelectionHost)));
		await flush();
		assert.ok(loaded.renders > settled);
		assert.equal(loaded.lists.size, 1, "one ordinals list across renders");
		await act(async () => root.unmount());
		container.remove();
	});

	it("keeps a deliberate Deselect all on the migrate page", async () => {
		const { default: MigratePage } = await import(
			"@/app/(main)/wallet/migrate/page"
		);
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		await act(async () => root.render(React.createElement(MigratePage)));
		await flush();

		const body = () => document.body.textContent ?? "";
		assert.match(body(), /2 ordinals, all selected\./);

		await act(async () => button("Choose ordinals").click());
		await flush();
		await act(async () => button("Deselect all").click());
		await flush();
		assert.match(body(), /0 of 2 ordinals selected\./);

		// Later renders (scan progress, toolbox updates) keep the choice.
		stubs.toolbox = { ...stubs.toolbox };
		await act(async () => root.render(React.createElement(MigratePage)));
		await flush();
		assert.match(body(), /0 of 2 ordinals selected\./);

		await act(async () => root.unmount());
		container.remove();
	});
});
