"use client";

import { useHotkey, useHotkeys } from "@tanstack/react-hotkeys";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import * as React from "react";
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandShortcut,
} from "@/components/ui/command";
import { isRouteAvailableOn } from "@/lib/chain-surfaces";
import { useStackFeatures } from "@/lib/hooks/use-stack-features";
import { useWalletChain } from "@/lib/hooks/use-wallet-chain";
import {
	CHORD_SHORTCUTS,
	goHintFor,
	goShortcutBindings,
} from "@/lib/keyboard-shortcuts";
import type { StackFeature } from "@/lib/stack-features";

/** Pages the command menu offers. Their key hints come from GO_SHORTCUTS. */
const commands: Array<{ label: string; href: string; feature?: StackFeature }> =
	[
		{ label: "Home", href: "/" },
		{ label: "Activity", href: "/activity", feature: "activity" },
		{
			label: "Ordinal market",
			href: "/market/ordinals",
			feature: "ordinalMarket",
		},
		{ label: "BSV21 market", href: "/market/bsv21", feature: "bsv21" },
		{ label: "Inscribe", href: "/inscribe", feature: "inscribe" },
		{ label: "Wallet", href: "/wallet" },
		{ label: "Wallet identity", href: "/wallet/identity", feature: "identity" },
		{ label: "Wallet ordinals", href: "/wallet/ordinals", feature: "ordinals" },
		{ label: "Wallet tokens", href: "/wallet/tokens" },
		{ label: "Wallet history", href: "/wallet/history" },
		{ label: "Wallet settings", href: "/wallet/settings" },
		{ label: "Download", href: "/download" },
		{ label: "Documentation", href: "/docs" },
		{ label: "Settings", href: "/settings" },
	];

/**
 * Site-wide shortcuts: "go to" sequences, the command menu and the theme.
 * The sidebar toggles live in the sidebar layout, which owns their state.
 */
export function KeyboardShortcuts() {
	const router = useRouter();
	const { resolvedTheme, setTheme } = useTheme();
	const features = useStackFeatures().data?.features;
	const chain = useWalletChain();
	const [commandMenuOpen, setCommandMenuOpen] = React.useState(false);

	useHotkeys(
		goShortcutBindings({ chain, features, go: (href) => router.push(href) }),
	);
	useHotkey(CHORD_SHORTCUTS.commandMenu.hotkey, () =>
		setCommandMenuOpen((open) => !open),
	);
	// Not while typing in a field, as before.
	useHotkey(
		CHORD_SHORTCUTS.toggleTheme.hotkey,
		() => setTheme(resolvedTheme === "dark" ? "light" : "dark"),
		{ ignoreInputs: true },
	);

	return (
		<CommandDialog open={commandMenuOpen} onOpenChange={setCommandMenuOpen}>
			<CommandInput placeholder="Search pages…" />
			<CommandList>
				<CommandEmpty>No matching page.</CommandEmpty>
				<CommandGroup heading="Navigate">
					{commands.map((command) => {
						if (command.feature && !features?.[command.feature]) return null;
						if (!isRouteAvailableOn(chain, command.href)) return null;
						const hint = goHintFor(command.href);
						return (
							<CommandItem
								key={command.href}
								onSelect={() => {
									setCommandMenuOpen(false);
									router.push(command.href);
								}}
							>
								{command.label}
								{hint && (
									<CommandShortcut>{hint.toUpperCase()}</CommandShortcut>
								)}
							</CommandItem>
						);
					})}
				</CommandGroup>
			</CommandList>
		</CommandDialog>
	);
}
