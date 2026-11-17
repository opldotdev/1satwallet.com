import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Chain } from "../lib/chain-endpoints";
import {
	CHORD_SHORTCUTS,
	GO_SHORTCUTS,
	goHintFor,
	goShortcutBindings,
} from "../lib/keyboard-shortcuts";
import type { StackFeature } from "../lib/stack-features";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const ALL_FEATURES: Record<StackFeature, boolean> = {
	activity: true,
	bsv21: true,
	identity: true,
	inscribe: true,
	opns: true,
	ordinalMarket: true,
	ordinals: true,
	social: true,
};

/** Modules load after the DOM is in place, so the component reads them here. */
const loaded: {
	hotkeys?: typeof import("@tanstack/react-hotkeys");
	React?: typeof import("react");
	visited: string[];
} = { visited: [] };

function Bindings({
	chain,
	features,
	extra,
}: {
	chain: Chain;
	features: Partial<Record<StackFeature, boolean>> | undefined;
	extra?: () => void;
}) {
	const { hotkeys, React } = loaded;
	if (!hotkeys || !React) throw new Error("DOM modules not loaded");
	hotkeys.useHotkeys(
		goShortcutBindings({
			chain,
			features,
			go: (href) => loaded.visited.push(href),
		}),
	);
	extra?.();
	return React.createElement("input", { "aria-label": "search" });
}

describe("keyboard shortcuts", () => {
	// A real DOM, so the keys go through TanStack Hotkeys as in a browser.
	let React: typeof import("react");
	let act: typeof import("react").act;
	let createRoot: typeof import("react-dom/client").createRoot;
	let hotkeys: typeof import("@tanstack/react-hotkeys");
	let root: import("react-dom/client").Root;
	let container: HTMLElement;
	let visited: string[];

	before(async () => {
		GlobalRegistrator.register();
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		React = await import("react");
		act = React.act;
		({ createRoot } = await import("react-dom/client"));
		hotkeys = await import("@tanstack/react-hotkeys");
		loaded.hotkeys = hotkeys;
		loaded.React = React;
	});

	after(async () => {
		await GlobalRegistrator.unregister();
	});

	beforeEach(() => {
		visited = [];
		loaded.visited = visited;
	});

	async function mount(
		chain: Chain = "main",
		features: Partial<Record<StackFeature, boolean>> | undefined = ALL_FEATURES,
		extra?: () => void,
	) {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		await act(async () => {
			root.render(
				React.createElement(hotkeys.HotkeysProvider, {
					defaultOptions: { platform: "linux" },
					children: React.createElement(Bindings, { chain, features, extra }),
				}),
			);
		});
	}

	async function unmount() {
		await act(async () => root.unmount());
		container.remove();
	}

	async function press(
		key: string,
		init: KeyboardEventInit = {},
		target: EventTarget = document.body,
	) {
		const code = /^[a-z]$/i.test(key)
			? `Key${key.toUpperCase()}`
			: /^\d$/.test(key)
				? `Digit${key}`
				: ({ ",": "Comma", "[": "BracketLeft", "]": "BracketRight" }[key] ??
					key);
		await act(async () => {
			target.dispatchEvent(
				new KeyboardEvent("keydown", {
					key,
					code,
					bubbles: true,
					cancelable: true,
					...init,
				}),
			);
			target.dispatchEvent(
				new KeyboardEvent("keyup", { key, code, bubbles: true, ...init }),
			);
		});
	}

	it("goes to every page the sidebars and Settings show a key for", async () => {
		await mount();
		for (const shortcut of GO_SHORTCUTS) {
			await press("g");
			await press(shortcut.key);
		}
		await unmount();
		assert.deepEqual(
			visited,
			GO_SHORTCUTS.map((shortcut) => shortcut.href),
		);
	});

	it("leaves keys alone while typing in a field", async () => {
		await mount();
		const input = container.querySelector("input");
		assert.ok(input);
		input.focus();
		await press("g", {}, input);
		await press("w", {}, input);
		await unmount();
		assert.deepEqual(visited, []);
	});

	it("does nothing for a page the stack or network lacks", async () => {
		await mount("main", { ...ALL_FEATURES, ordinals: false });
		await press("g");
		await press("o");
		await unmount();
		assert.deepEqual(visited, []);

		await mount("test", ALL_FEATURES);
		await press("g");
		await press("m");
		await press("g");
		await press("w");
		await unmount();
		assert.deepEqual(visited, ["/wallet"]);
	});

	it("needs g and the key within a second", async () => {
		await mount();
		await press("w");
		await unmount();
		assert.deepEqual(visited, []);
	});

	it("toggles a sidebar with Mod+[ and Mod+], even from a field", async () => {
		const toggled: string[] = [];
		await mount("main", ALL_FEATURES, () => {
			hotkeys.useHotkey(CHORD_SHORTCUTS.leftSidebar.hotkey, () =>
				toggled.push("left"),
			);
			hotkeys.useHotkey(CHORD_SHORTCUTS.rightSidebar.hotkey, () =>
				toggled.push("right"),
			);
		});
		const input = container.querySelector("input");
		assert.ok(input);
		input.focus();
		await press("[", { ctrlKey: true }, input);
		await press("]", { ctrlKey: true });
		await unmount();
		assert.deepEqual(toggled, ["left", "right"]);
	});

	it("points every key at a page that exists", () => {
		// Route groups such as (main) don't show in the address.
		const routes = new Set(
			readdirSync(join(process.cwd(), "app"), { recursive: true })
				.map(String)
				.filter((file) => /(^|\/)page\.(tsx|mdx)$/.test(file))
				.map(
					(file) =>
						`/${file
							.split("/")
							.slice(0, -1)
							.filter((part) => !/^\(.*\)$/.test(part))
							.join("/")}`,
				),
		);
		for (const { href } of GO_SHORTCUTS) assert.ok(routes.has(href), href);
		assert.equal(
			new Set(GO_SHORTCUTS.map((shortcut) => shortcut.key)).size,
			GO_SHORTCUTS.length,
		);
	});

	it("shows hints only from the one shortcut list", () => {
		for (const file of [
			"components/app-sidebar.tsx",
			"components/left-sidebar.tsx",
			"components/settings/settings-form.tsx",
			"components/keyboard-shortcuts.tsx",
		]) {
			assert.doesNotMatch(read(file), /["']g [a-z0-9,]["']/i, file);
		}
		assert.equal(goHintFor("/wallet/history"), "g y");
		assert.equal(goHintFor("/download"), undefined);
		assert.doesNotMatch(
			read("components/dual-sidebar-layout.tsx"),
			/@\/hooks\/use-hotkeys/,
		);
	});
});
