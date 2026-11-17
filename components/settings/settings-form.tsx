"use client";

import { ChevronRight, Moon, Wallet } from "lucide-react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { SettingsGroup, SettingsRow } from "@/components/settings/settings-row";
import { ThemeTokenPicker } from "@/components/settings/theme-token-picker";
import { Card, CardContent } from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/section-header";
import { Switch } from "@/components/ui/switch";
import { useSound } from "@/hooks/use-sound";
import { useMounted } from "@/lib/hooks/use-mounted";

const SHORTCUTS: readonly {
	group: string;
	keys: readonly (readonly [label: string, key: string])[];
}[] = [
	{
		group: "Global",
		keys: [
			["Left sidebar", "⌘ ["],
			["Right sidebar", "⌘ ]"],
		],
	},
	{
		group: "Go to (g + key)",
		keys: [
			["Home", "h"],
			["Activity", "a"],
			["Settings", "s"],
		],
	},
	{
		group: "Market",
		keys: [
			["Ordinals", "m"],
			["BSV21", "v"],
		],
	},
	{
		group: "Wallet",
		keys: [
			["Dashboard", "w"],
			["History", "y"],
		],
	},
];

export function SettingsForm() {
	const { play } = useSound();
	const { theme, setTheme } = useTheme();
	const mounted = useMounted();

	if (!mounted) return null;

	return (
		<div className="flex flex-col gap-6">
			<SettingsGroup title="Appearance">
				<SettingsRow
					icon={Moon}
					title="Dark mode"
					description="Use the dark theme."
					htmlFor="dark-mode"
					control={
						<Switch
							id="dark-mode"
							checked={theme === "dark"}
							onCheckedChange={(checked) => {
								play("click");
								setTheme(checked ? "dark" : "light");
							}}
						/>
					}
				/>
			</SettingsGroup>

			<ThemeTokenPicker />

			<section className="flex flex-col gap-3">
				<SectionHeader title="Wallet" />
				<Link
					href="/wallet/settings"
					className="group rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
					onClick={() => play("click")}
				>
					<Card className="transition-colors group-hover:bg-accent/50">
						<CardContent className="flex items-center gap-3">
							<Wallet
								aria-hidden="true"
								className="size-5 shrink-0 text-muted-foreground"
							/>
							<div className="flex min-w-0 flex-1 flex-col gap-1">
								<p className="text-sm font-medium">Wallet settings</p>
								<p className="text-muted-foreground text-sm">
									Privacy, currency, sync and connected apps.
								</p>
							</div>
							<ChevronRight
								aria-hidden="true"
								className="size-5 shrink-0 text-muted-foreground"
							/>
						</CardContent>
					</Card>
				</Link>
			</section>

			{/* A phone has no keyboard to use them with. */}
			<section className="flex flex-col gap-3 max-md:hidden">
				<SectionHeader title="Keyboard shortcuts" />
				<Card>
					<CardContent className="grid grid-cols-2 gap-6 text-sm lg:grid-cols-4">
						{SHORTCUTS.map(({ group, keys }) => (
							<div key={group} className="flex flex-col gap-1">
								<p className="font-medium">{group}</p>
								{keys.map(([label, key]) => (
									<div
										key={label}
										className="flex justify-between gap-3 text-xs"
									>
										<span className="text-muted-foreground">{label}</span>
										<kbd className="font-mono">{key}</kbd>
									</div>
								))}
							</div>
						))}
					</CardContent>
				</Card>
			</section>
		</div>
	);
}
