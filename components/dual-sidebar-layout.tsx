"use client";

import { useHotkey } from "@tanstack/react-hotkeys";
import { PanelLeft, Wallet } from "lucide-react";
import type * as React from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { LeftSidebar } from "@/components/left-sidebar";
import { MainnetOnly } from "@/components/mainnet-only";
import { SidebarSoundEffects } from "@/components/sidebar-sound-effects";
import { Button } from "@/components/ui/button";
import {
	SidebarInset,
	SidebarProvider,
	useSidebar,
} from "@/components/ui/sidebar";
import { FullScreenUnlock } from "@/components/wallet/full-screen-unlock";
import { MigrationWizard } from "@/components/wallet/migration-wizard";
import { CHORD_SHORTCUTS } from "@/lib/keyboard-shortcuts";

// Wrapper to handle Left Sidebar shortcuts and context
function LeftSidebarWrapper({ children }: { children: React.ReactNode }) {
	const { toggleSidebar } = useSidebar();
	useHotkey(CHORD_SHORTCUTS.leftSidebar.hotkey, toggleSidebar);
	return (
		<>
			<SidebarSoundEffects />
			{children}
		</>
	);
}

// Wrapper to handle Right Sidebar shortcuts and context
function RightSidebarWrapper({ children }: { children: React.ReactNode }) {
	const { toggleSidebar } = useSidebar();
	useHotkey(CHORD_SHORTCUTS.rightSidebar.hotkey, toggleSidebar);
	return (
		<>
			<SidebarSoundEffects />
			{children}
		</>
	);
}

function InnerLayout({ children }: { children: React.ReactNode }) {
	const { toggleSidebar: toggleLeft } = useSidebar(); // Access Outer (Left) Context

	return (
		<SidebarProvider defaultOpen={false} cookieName="sidebar_right">
			<RightSidebarWrapper>
				<InnerContent toggleLeft={toggleLeft}>{children}</InnerContent>
				<AppSidebar side="right" />
			</RightSidebarWrapper>
		</SidebarProvider>
	);
}

// Separate component to access Inner Context
function InnerContent({
	children,
	toggleLeft,
}: {
	children: React.ReactNode;
	toggleLeft: () => void;
}) {
	const { toggleSidebar: toggleRight } = useSidebar(); // Inner (Right) Context
	return (
		<SidebarInset>
			<header className="flex h-[calc(--spacing(16)+env(safe-area-inset-top))] max-md:h-[calc(--spacing(12)+env(safe-area-inset-top))] shrink-0 items-center justify-between gap-2 border-b pt-[env(safe-area-inset-top)] pr-[max(1rem,env(safe-area-inset-right))] pl-4 max-md:pl-[max(1rem,env(safe-area-inset-left))] transition-[width,height] ease-linear group-has-[[data-collapsible=icon]]/sidebar-wrapper:h-[calc(--spacing(12)+env(safe-area-inset-top))]">
				<div className="flex items-center gap-2">
					<Button
						variant="ghost"
						size="icon"
						className="-ml-1"
						onClick={toggleLeft}
					>
						<PanelLeft />
						<span className="sr-only">Toggle Sidebar</span>
					</Button>
				</div>
				<div className="flex items-center gap-2">
					{/* Opens the wallet panel, so it wears the wallet's icon. */}
					<Button
						aria-label="Toggle wallet navigation"
						className="-mr-1"
						data-sidebar="trigger"
						onClick={toggleRight}
						size="icon"
						title="Toggle wallet navigation"
						variant="ghost"
					>
						<Wallet />
					</Button>
				</div>
			</header>
			{/* The shell owns the side and bottom safe-area insets (viewport-fit=
			    cover), so every page clears the notch and home indicator whether
			    or not it uses Page. The header pads its own. From md the left
			    icon rail takes the left inset, so only phones pad it here. */}
			<div className="flex flex-1 flex-col gap-4 pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] max-md:pl-[env(safe-area-inset-left)]">
				{children}
			</div>
		</SidebarInset>
	);
}

export function DualSidebarLayout({ children }: { children: React.ReactNode }) {
	return (
		<SidebarProvider defaultOpen={false} cookieName="sidebar_left">
			<LeftSidebarWrapper>
				<FullScreenUnlock />
				{/* Legacy assets live on mainnet only. */}
				<MainnetOnly fallback={null}>
					<MigrationWizard />
				</MainnetOnly>
				<LeftSidebar side="left" collapsible="icon" />
				<InnerLayout>{children}</InnerLayout>
			</LeftSidebarWrapper>
		</SidebarProvider>
	);
}
