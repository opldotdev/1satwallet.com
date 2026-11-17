import type {
	HotkeyChord,
	HotkeySequence,
	UseHotkeyDefinition,
} from "@tanstack/react-hotkeys";
import type { Chain } from "@/lib/chain-endpoints";
import { isRouteAvailableOn } from "@/lib/chain-surfaces";
import type { StackFeature } from "@/lib/stack-features";

/**
 * Every keyboard shortcut the site has, in one place. The handler, the
 * command menu, the sidebars' hints and the Settings list all read this
 * list, so a hint never shows a key that does nothing.
 */

/** "Go to" shortcuts: press g, then the key, within a second. */
export interface GoShortcut {
	key: string;
	href: string;
	label: string;
	/** Where Settings lists it. */
	group: "Go to" | "Market" | "Wallet";
	/** The stack has to serve this for the page to exist. */
	feature?: StackFeature;
}

export const GO_SHORTCUTS: readonly GoShortcut[] = [
	{ key: "h", href: "/", label: "Home", group: "Go to" },
	{
		key: "a",
		href: "/activity",
		label: "Activity",
		group: "Go to",
		feature: "activity",
	},
	{
		key: "i",
		href: "/inscribe",
		label: "Inscribe",
		group: "Go to",
		feature: "inscribe",
	},
	{ key: "d", href: "/docs", label: "Documentation", group: "Go to" },
	{ key: "s", href: "/settings", label: "Settings", group: "Go to" },
	{
		key: "m",
		href: "/market/ordinals",
		label: "Ordinals",
		group: "Market",
		feature: "ordinalMarket",
	},
	{
		key: "v",
		href: "/market/bsv21",
		label: "BSV21",
		group: "Market",
		feature: "bsv21",
	},
	{ key: "w", href: "/wallet", label: "Dashboard", group: "Wallet" },
	{
		key: "o",
		href: "/wallet/ordinals",
		label: "Ordinals",
		group: "Wallet",
		feature: "ordinals",
	},
	{ key: "1", href: "/wallet/tokens", label: "Tokens", group: "Wallet" },
	{ key: "y", href: "/wallet/history", label: "History", group: "Wallet" },
	{
		key: ",",
		href: "/wallet/settings",
		label: "Settings",
		group: "Wallet",
	},
];

/** The two steps TanStack Hotkeys matches, such as ["G", "W"]. */
export const goSequence = (shortcut: GoShortcut): HotkeySequence => [
	"G",
	shortcut.key.toUpperCase() as HotkeyChord,
];

/** The hint the sidebars and command menu show, such as "g w". */
export function goHintFor(href: string): string | undefined {
	const shortcut = GO_SHORTCUTS.find((entry) => entry.href === href);
	return shortcut ? `g ${shortcut.key}` : undefined;
}

/** Chords that hold a modifier. "Mod" is ⌘ on a Mac and Ctrl elsewhere. */
export const CHORD_SHORTCUTS = {
	commandMenu: { hotkey: "Mod+K", label: "Search pages" },
	toggleTheme: { hotkey: "Mod+Shift+D", label: "Light or dark" },
	leftSidebar: { hotkey: "Mod+[", label: "Left sidebar" },
	rightSidebar: { hotkey: "Mod+]", label: "Right sidebar" },
} as const;

/** A field the user types into, where g and a letter are just text. */
export function isTextEntry(target: EventTarget | null): boolean {
	if (!target || typeof (target as Element).matches !== "function")
		return false;
	const element = target as HTMLElement;
	return (
		element.isContentEditable ||
		element.matches(
			"textarea, select, input:not([type=button], [type=checkbox], [type=radio], [type=submit], [type=reset], [type=range], [type=color], [type=file])",
		)
	);
}

/**
 * The "go to" bindings for useHotkeys. A shortcut whose page the stack or
 * the wallet's network lacks stays registered but does nothing, so its keys
 * don't fall through to another binding.
 *
 * Only typing in a field holds them back. TanStack's own input rule also
 * skips single keys while a menu, listbox or combobox has focus, and a Radix
 * Select trigger keeps focus after it closes, which would leave g dead until
 * something else is clicked. So the field check is ours, and these keys
 * never prevent or stop anything, as before.
 */
export function goShortcutBindings({
	chain,
	features,
	go,
}: {
	chain: Chain;
	features: Partial<Record<StackFeature, boolean>> | undefined;
	go: (href: string) => void;
}): UseHotkeyDefinition[] {
	return GO_SHORTCUTS.map((shortcut) => ({
		hotkey: goSequence(shortcut),
		callback: (event: KeyboardEvent) => {
			if (!isTextEntry(event.target)) go(shortcut.href);
		},
		options: {
			enabled:
				(!shortcut.feature || features?.[shortcut.feature] === true) &&
				isRouteAvailableOn(chain, shortcut.href),
			ignoreInputs: false,
			preventDefault: false,
			stopPropagation: false,
			meta: { name: shortcut.label },
		},
	}));
}
