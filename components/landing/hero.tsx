"use client";

import { ArrowRight, Lock, Users, Wallet } from "lucide-react";
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
		<div className="flex h-[200px] items-center justify-center sm:h-[280px] md:h-[360px]">
			<Image
				alt="1Sat Wallet"
				fetchPriority="high"
				className="size-[120px] sm:size-[160px]"
				height={160}
				priority
				src="/oneSatLogoDark.svg"
				width={160}
			/>
		</div>
	);
}

const Logo3D = dynamic(
	() => import("@/components/landing/logo-3d").then(({ Logo3D }) => Logo3D),
	{ ssr: false, loading: StaticLogo },
);

/** What the floor means for this visitor, said under the tagline. */
function floorCallToAction(state: FloorState): {
	label: string;
	icon: "wallet" | "lock";
	note: string | null;
} {
	switch (state.kind) {
		case "signed-out":
			return {
				label: "Connect wallet to enter",
				icon: "wallet",
				note: "The live P2P trading floor opens when you connect a wallet. Until then you're not on it, and no one on it is shown here.",
			};
		case "locked":
			return {
				label: "Unlock wallet to enter",
				icon: "lock",
				note: "Unlock your wallet to join the live P2P trading floor.",
			};
		default:
			return { label: "Open wallet", icon: "wallet", note: null };
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
			<div className="absolute inset-0 z-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-primary/10 via-background to-background" />
			<div
				aria-hidden="true"
				className="absolute inset-0 z-0 opacity-25"
				style={{
					backgroundImage:
						"radial-gradient(circle, color-mix(in oklab, var(--primary) 38%, transparent) 1px, transparent 1px)",
					backgroundSize: "28px 28px",
					maskImage:
						"radial-gradient(ellipse at 50% 42%, black 0%, transparent 70%)",
					WebkitMaskImage:
						"radial-gradient(ellipse at 50% 42%, black 0%, transparent 70%)",
				}}
			/>

			<div className="relative z-20 w-full px-6 text-center">
				<h1 className="sr-only">1Sat Wallet</h1>
				<div>
					<div aria-hidden="true">
						<ThreeBoundary>
							{useStaticLogo ? <StaticLogo /> : <Logo3D />}
						</ThreeBoundary>
					</div>

					<p className="mx-auto max-w-3xl text-lg font-light leading-relaxed text-muted-foreground sm:text-xl md:text-2xl">
						Satoshi's favorite asset wallet.
						<br />
						Trade with peers.{" "}
						<span className="text-primary">No servers. No middleman.</span>
					</p>
				</div>

				<div className="mx-auto mt-7 flex max-w-md flex-col items-center gap-4">
					<Button
						className="scale-100 font-bold shadow-[0_0_20px_-5px_var(--primary)] transition-[box-shadow,transform] duration-300 hover:scale-105 hover:shadow-[0_0_30px_-5px_var(--primary)]"
						asChild
						onClick={() => play("click")}
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
					{cta.note ? (
						<p
							className="flex items-start gap-2 text-left text-sm leading-relaxed text-muted-foreground"
							data-testid="floor-note"
						>
							<Users
								aria-hidden="true"
								className="mt-0.5 size-4 shrink-0 text-primary"
							/>
							{cta.note}
						</p>
					) : null}
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
