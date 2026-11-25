"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useMediaQuery } from "usehooks-ts";
import { ThreeBoundary } from "@/components/landing/three-boundary";
import { UnderPageHeading } from "@/components/not-on-testnet";
import { Page } from "@/components/page-layout";
import { Button } from "@/components/ui/button";
import { WalletConnectCarousel } from "@/components/wallet/wallet-connect-carousel";
import { WalletHeader } from "@/components/wallet/wallet-header";
import { WalletHome } from "@/components/wallet/wallet-home";
import { WalletTabs } from "@/components/wallet/wallet-tabs";
import { useSound } from "@/hooks/use-sound";
import { useWallet } from "@/providers/wallet-provider";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import { SharedPresence, useLandingFloor } from "./shared-presence";
import { TradeRequestListener } from "./trade-request-listener";

// The logo box (here and in Logo3D) is short enough that the wallet chooser
// and its slide picker under it show in a 1280x800 window.
function StaticLogo() {
	return (
		<div className="flex h-[104px] items-center justify-center sm:h-[160px] md:h-[200px]">
			<Image
				alt="1Sat Wallet"
				fetchPriority="high"
				className="size-[88px] sm:size-[120px] md:size-[140px]"
				height={220}
				priority
				src="/oneSatLogoDark.svg"
				width={220}
			/>
		</div>
	);
}

const Logo3D = dynamic(
	() => import("@/components/landing/logo-3d").then(({ Logo3D }) => Logo3D),
	{ ssr: false, loading: StaticLogo },
);

/**
 * Home is the wallet. Signed in, it is the wallet overview (the same header,
 * tabs and balance as /wallet) with the P2P floor around it. Signed out with
 * no wallet here, it is the logo and the wallet chooser (the same one as
 * /wallet), which leads with what discovery finds. Locked, or with a wallet
 * stored here, it is the logo and Unlock or Open wallet.
 */
export function LandingHero() {
	const floor = useLandingFloor();
	const { play } = useSound();
	const { hasWallet, isWalletInitialized, isWalletLocked } = useWallet();
	const { connectionStatus, identityKey, isInitialized, isInitializing } =
		useWalletToolbox();
	const useStaticLogo = useMediaQuery(
		"(max-width: 767px), (prefers-reduced-motion: reduce)",
		{ initializeWithValue: false },
	);
	const signedIn = isInitialized && Boolean(identityKey);
	const locked =
		connectionStatus === "locked" ||
		connectionStatus === "authorization-required" ||
		(hasWallet && isWalletLocked);
	// Until the wallet is known, show only the logo, so a returning visitor
	// never sees Create and Import flash before their wallet appears.
	const resolving =
		!isWalletInitialized ||
		isInitializing ||
		connectionStatus === "authenticating" ||
		floor.state.kind === "checking";
	// The chooser shows once the wallet is known and there is none here, and
	// stays mounted while a wallet it picked connects (which counts as
	// resolving), so its own Connecting state and errors stay on screen.
	const [chooserShown, setChooserShown] = useState(false);
	const noWalletHere = !signedIn && !locked && !hasWallet;
	useEffect(() => {
		if (!resolving && noWalletHere) setChooserShown(true);
	}, [resolving, noWalletHere]);
	const choosing = noWalletHere && (chooserShown || !resolving);
	const barShown =
		floor.state.kind === "live" ||
		floor.state.kind === "joining" ||
		floor.state.kind === "error" ||
		floor.state.kind === "left";

	return (
		<div
			className={`relative flex min-h-0 flex-1 flex-col overflow-x-clip bg-background selection:bg-primary/20 ${signedIn ? "" : "items-center justify-center"} ${barShown ? "pb-28" : "pb-8"}`}
		>
			{/* No stacking context here: decoration sits under peer cursors (z-30),
			    controls and the wallet sit above them (z-40) so a cursor never
			    takes their clicks. */}
			{signedIn ? (
				<Page className="relative z-40">
					<WalletHeader />
					<WalletTabs />
					<UnderPageHeading>
						<div className="min-w-0 space-y-6">
							<WalletHome />
						</div>
					</UnderPageHeading>
				</Page>
			) : (
				<>
					{/* The chooser's opaque slides would cut the glow into a box. */}
					{choosing ? null : (
						<div
							aria-hidden="true"
							className="absolute inset-0 z-0 bg-[radial-gradient(ellipse_at_50%_40%,_var(--tw-gradient-stops))] from-primary/12 via-background to-background"
						/>
					)}
					<div className="relative w-full px-6 text-center">
						<div className="relative z-20">
							<div aria-hidden="true" data-testid="hero-logo">
								<ThreeBoundary
									fallback={
										<div data-testid="hero-logo-fallback">
											<StaticLogo />
										</div>
									}
								>
									{useStaticLogo ? <StaticLogo /> : <Logo3D />}
								</ThreeBoundary>
							</div>
							<h1 className="mt-3 text-xl font-semibold tracking-tight md:mt-0 md:text-2xl">
								1Sat Wallet
							</h1>
						</div>
						{choosing ? (
							<div className="relative z-40 mx-auto mt-2 w-full max-w-3xl">
								<WalletConnectCarousel />
							</div>
						) : resolving ? null : (
							<div className="relative z-40 mx-auto mt-8 flex max-w-xs flex-col gap-2">
								<Button
									asChild
									className="h-12 w-full text-base font-bold"
									data-testid="hero-cta"
									onClick={() => play("click")}
									size="lg"
								>
									<Link href="/wallet">
										{locked ? "Unlock wallet" : "Open wallet"}
									</Link>
								</Button>
							</div>
						)}
					</div>
				</>
			)}

			<SharedPresence floor={floor} />
			<TradeRequestListener />
		</div>
	);
}
