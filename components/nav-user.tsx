"use client";

import {
	ChevronsUpDown,
	Laptop,
	LogOut,
	Puzzle,
	Smartphone,
	Wallet,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from "@/components/ui/sidebar";
import {
	BlockedHelpText,
	PRIMER_LOOK,
	PRIMER_SKIP,
	PRIMER_TITLE,
	PrimerText,
	STOP_WAITING,
	WaitingText,
} from "@/components/wallet/local-wallet-access";
import { useSound } from "@/hooks/use-sound";
import { useWalletDiscovery } from "@/hooks/use-wallet-discovery";
import type { WalletConnectionOption } from "@/lib/wallet/connection-options";
import { coverageFor } from "@/lib/wallet/discovery/discovery";
import { readLoopbackPermission } from "@/lib/wallet/discovery/loopback-permission";
import { canReachLocalWallet } from "@/lib/wallet/discovery/platform";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

export function NavUser({
	user,
}: {
	user: {
		name: string;
		email: string;
		address: string;
	};
}) {
	const { play } = useSound();
	const { isMobile } = useSidebar();
	const {
		connectionMode,
		disconnectExternalWallet,
		isInitializing,
		switchWallet,
	} = useWalletToolbox();
	const [menuOpen, setMenuOpen] = useState(false);
	const discovery = useWalletDiscovery(menuOpen);
	const { snapshot, phase } = discovery;
	const [localPanel, setLocalPanel] = useState<"primer" | "help" | null>(null);
	const [lookError, setLookError] = useState<string | null>(null);
	const [host, setHost] = useState("");
	useEffect(() => setHost(window.location.host), []);
	useEffect(() => {
		if (menuOpen) return;
		setLocalPanel(null);
		setLookError(null);
	}, [menuOpen]);

	const found = (option: "injected" | "desktop") =>
		!!snapshot?.candidates.some((candidate) => candidate.option === option);
	const windowCoverage = coverageFor(snapshot, "window.CWI");
	const local = coverageFor(snapshot, "loopback");
	const localNeedsAsk =
		local?.cause === "permission-required" ||
		local?.cause === "permission-declined";
	const localDenied = local?.cause === "permission-denied";
	const waiting = phase === "waiting";
	// Phones reach a wallet by app; there is no desktop wallet to switch to.
	const showDesktop =
		discovery.platform !== null && canReachLocalWallet(discovery.platform);

	const statusText = (option: "injected" | "desktop") => {
		const coverage = option === "injected" ? windowCoverage : local;
		if (found(option)) return "Available";
		if (option === "desktop" && waiting) return "Waiting";
		if (!coverage || phase === "scanning") return "Checking";
		if (option === "desktop" && localNeedsAsk) return "Look for it";
		if (option === "desktop" && localDenied) return "Blocked";
		if (coverage.state === "unsupported") return "Not found";
		return "Not detected";
	};

	const switchTo = (option: WalletConnectionOption) => {
		play("click");
		void switchWallet(option);
	};

	// Read the permission at the click, not from a scan that may not have
	// landed: switching probes this computer, which must never be the request
	// that raises the browser's question (BRC-325).
	const selectDesktop = async () => {
		const { state } = await readLoopbackPermission();
		if (state === "prompt") {
			setLocalPanel("primer");
			return;
		}
		if (state === "denied") {
			setLocalPanel("help");
			return;
		}
		setMenuOpen(false);
		switchTo("desktop");
	};

	const lookForLocalWallet = async () => {
		setLocalPanel(null);
		setLookError(null);
		try {
			const result = await discovery.elicit();
			if (!result) return;
			if (result.outcome === "denied") {
				setLocalPanel("help");
				return;
			}
			if (
				result.snapshot.candidates.some(({ adapter }) => adapter === "loopback")
			) {
				setMenuOpen(false);
				switchTo("desktop");
			}
		} catch (error) {
			setLookError(
				error instanceof Error
					? `Couldn't look for a wallet on this computer: ${error.message}`
					: "Couldn't look for a wallet on this computer.",
			);
		}
	};

	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
					<DropdownMenuTrigger asChild>
						<SidebarMenuButton
							size="lg"
							className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
						>
							<div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
								<Wallet className="h-4 w-4" />
							</div>
							<div className="grid flex-1 text-left text-sm leading-tight">
								<span className="truncate font-medium">{user.name}</span>
								<span className="truncate text-xs">{user.email}</span>
							</div>
							<ChevronsUpDown className="ml-auto size-4" />
						</SidebarMenuButton>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
						side={isMobile ? "bottom" : "right"}
						align="end"
						sideOffset={4}
					>
						<DropdownMenuLabel className="p-0 font-normal">
							<div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
								<div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted">
									<Wallet className="h-4 w-4" />
								</div>
								<div className="grid flex-1 text-left text-sm leading-tight">
									<span className="truncate font-medium">{user.name}</span>
									<span className="truncate text-xs">{user.email}</span>
								</div>
							</div>
						</DropdownMenuLabel>
						<DropdownMenuSeparator />
						<DropdownMenuLabel className="text-xs text-muted-foreground">
							Switch wallet
						</DropdownMenuLabel>
						<DropdownMenuItem
							disabled={isInitializing}
							onSelect={() => switchTo("injected")}
						>
							<Puzzle className="mr-2 h-4 w-4" />
							Injected
							<span className="ml-auto text-xs text-muted-foreground">
								{statusText("injected")}
							</span>
						</DropdownMenuItem>
						{showDesktop && (
							<DropdownMenuItem
								disabled={isInitializing || waiting}
								onSelect={(event) => {
									event.preventDefault();
									void selectDesktop();
								}}
							>
								<Laptop className="mr-2 h-4 w-4" />
								Desktop
								<span className="ml-auto text-xs text-muted-foreground">
									{statusText("desktop")}
								</span>
							</DropdownMenuItem>
						)}
						{/* Panel text is plain; its controls are menu items, so arrow
						    keys reach them (Radix menus keep Tab inside the menu). */}
						{waiting ? (
							<>
								<div className="space-y-2 px-2 py-2 text-sm">
									<WaitingText />
								</div>
								<DropdownMenuItem
									onSelect={(event) => {
										event.preventDefault();
										discovery.stopWaiting();
									}}
								>
									{STOP_WAITING}
								</DropdownMenuItem>
							</>
						) : localPanel === "primer" ? (
							<>
								<div className="space-y-2 px-2 py-2 text-sm">
									<p className="font-medium">{PRIMER_TITLE}</p>
									<PrimerText host={host} />
								</div>
								<DropdownMenuItem
									onSelect={(event) => {
										event.preventDefault();
										void lookForLocalWallet();
									}}
								>
									{PRIMER_LOOK}
								</DropdownMenuItem>
								<DropdownMenuItem
									onSelect={(event) => {
										event.preventDefault();
										setLocalPanel(null);
									}}
								>
									{PRIMER_SKIP}
								</DropdownMenuItem>
							</>
						) : localPanel === "help" ? (
							<>
								<div className="space-y-2 px-2 py-2 text-sm">
									<BlockedHelpText />
								</div>
								<DropdownMenuItem
									onSelect={(event) => {
										event.preventDefault();
										setLocalPanel(null);
									}}
								>
									Hide
								</DropdownMenuItem>
							</>
						) : null}
						{lookError && (
							<p className="px-2 py-1 text-sm text-destructive" role="alert">
								{lookError}
							</p>
						)}
						<DropdownMenuItem
							disabled={isInitializing}
							onSelect={() => switchTo("embedded")}
						>
							<Smartphone className="mr-2 h-4 w-4" />
							Built-in
						</DropdownMenuItem>
						<DropdownMenuSeparator />

						{connectionMode === "external" ? (
							<DropdownMenuItem
								onSelect={() => {
									play("click");
									void disconnectExternalWallet();
								}}
							>
								<LogOut className="mr-2 h-4 w-4" />
								Disconnect Wallet
							</DropdownMenuItem>
						) : (
							<DropdownMenuItem asChild onClick={() => play("click")}>
								<Link
									href="/wallet/delete"
									className="flex w-full items-center text-destructive focus:text-destructive cursor-pointer"
								>
									<LogOut className="mr-2 h-4 w-4" />
									Delete Wallet
								</Link>
							</DropdownMenuItem>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarMenuItem>
		</SidebarMenu>
	);
}
