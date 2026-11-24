"use client";

import { ArrowRight, Lock, Wallet } from "lucide-react";
import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { useMediaQuery } from "usehooks-ts";
import { ThreeBoundary } from "@/components/landing/three-boundary";
import { Button } from "@/components/ui/button";
import { useSound } from "@/hooks/use-sound";
import type { FloorState } from "@/lib/p2p-floor";
import { SharedPresence, useLandingFloor } from "./shared-presence";
import { TradeRequestListener } from "./trade-request-listener";

function StaticLogo() {
	return (
		<div className="flex h-[104px] items-center justify-center sm:h-[200px] md:h-[360px]">
			<Image
				alt="1Sat Wallet"
				fetchPriority="high"
				className="size-[88px] sm:size-[140px] md:size-[220px]"
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

/** The button label carries what the floor needs from this visitor. */
function floorCallToAction(state: FloorState): {
	label: string;
	icon: "wallet" | "lock";
} {
	switch (state.kind) {
		case "signed-out":
			return { label: "Connect wallet to enter", icon: "wallet" };
		case "locked":
			return { label: "Unlock wallet to enter", icon: "lock" };
		default:
			return { label: "Open wallet", icon: "wallet" };
	}
}

export function LandingHero() {
	const floor = useLandingFloor();
	const { play } = useSound();
	const useStaticLogo = useMediaQuery(
		"(max-width: 767px), (prefers-reduced-motion: reduce)",
		{ initializeWithValue: false },
	);
	const cta = floorCallToAction(floor.state);
	const barShown =
		floor.state.kind === "live" ||
		floor.state.kind === "joining" ||
		floor.state.kind === "error" ||
		floor.state.kind === "left";

	return (
		<div
			className={`relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-x-hidden overflow-y-auto bg-background selection:bg-primary/20 ${barShown ? "pb-28" : "pb-8"}`}
		>
			<div className="absolute inset-0 z-0 bg-[radial-gradient(ellipse_at_50%_32%,_var(--tw-gradient-stops))] from-primary/15 via-background to-background" />
			<div
				aria-hidden="true"
				className="absolute inset-0 z-0 opacity-20"
				style={{
					backgroundImage:
						"radial-gradient(circle, color-mix(in oklab, var(--primary) 38%, transparent) 1px, transparent 1px)",
					backgroundSize: "28px 28px",
					maskImage:
						"radial-gradient(ellipse at 50% 32%, black 0%, transparent 62%)",
					WebkitMaskImage:
						"radial-gradient(ellipse at 50% 32%, black 0%, transparent 62%)",
				}}
			/>

			{/* No stacking context here: the logo and tagline sit under peer cursors (z-30),
			    the call-to-action sits above them (z-40) so a cursor never takes its click. */}
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

					<h1 className="mx-auto mt-3 max-w-4xl text-balance text-[clamp(1.7rem,8.4vw,2.25rem)] font-bold leading-[1.05] tracking-tight text-foreground sm:text-5xl md:mt-0">
						Satoshi's favorite asset wallet.
					</h1>
					<p className="mx-auto mt-3 max-w-xl text-base leading-snug text-muted-foreground sm:mt-4 sm:text-lg md:text-xl">
						Trade with peers.{" "}
						<span className="block font-medium text-primary sm:inline">
							No servers. No middleman.
						</span>
					</p>
				</div>

				<div className="relative z-40 mx-auto mt-7 flex max-w-xs flex-col items-center gap-1 sm:mt-8 sm:max-w-md">
					<Button
						asChild
						className="h-12 w-full px-8 text-base font-bold shadow-[0_0_28px_-8px_var(--primary)] transition-[box-shadow,transform] duration-300 hover:scale-[1.03] hover:shadow-[0_0_36px_-6px_var(--primary)] sm:w-auto"
						data-testid="hero-cta"
						onClick={() => play("click")}
						size="lg"
					>
						<Link href="/wallet">
							{cta.icon === "lock" ? (
								<Lock className="size-5" data-icon="inline-start" />
							) : (
								<Wallet className="size-5" data-icon="inline-start" />
							)}
							{cta.label}
						</Link>
					</Button>
					<Link
						className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
						href="/download"
						onClick={() => play("click")}
					>
						Get the Apple app
						<ArrowRight aria-hidden="true" className="size-4" />
					</Link>
				</div>
			</div>

			<SharedPresence floor={floor} />
			<TradeRequestListener />
		</div>
	);
}
