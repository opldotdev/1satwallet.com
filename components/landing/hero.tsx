"use client";

import { ArrowRight, CircleHelp, Wallet } from "lucide-react";
import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { useMediaQuery } from "usehooks-ts";
import { ThreeBoundary } from "@/components/landing/three-boundary";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/ui/popover";
import { useSound } from "@/hooks/use-sound";
import { useWallet } from "@/providers/wallet-provider";
import { SharedPresence } from "./shared-presence";
import { TradeRequestListener } from "./trade-request-listener";

function StaticLogo() {
	return (
		<div className="flex h-[280px] items-center justify-center md:h-[360px]">
			<Image
				alt="1Sat Wallet"
				fetchPriority="high"
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

export function LandingHero() {
	const { hasWallet } = useWallet();
	const { play } = useSound();
	const useStaticLogo = useMediaQuery(
		"(max-width: 767px), (prefers-reduced-motion: reduce)",
		{ initializeWithValue: false },
	);

	return (
		<div className="relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden bg-background selection:bg-primary/20">
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

			<div className="relative z-10 w-full px-6 text-center">
				<div>
					<ThreeBoundary>
						{useStaticLogo ? <StaticLogo /> : <Logo3D />}
					</ThreeBoundary>

					<p className="mx-auto max-w-3xl text-xl font-light leading-relaxed text-muted-foreground md:text-2xl">
						Satoshi's favorite asset wallet.
						<br />
						Trade with peers.{" "}
						<span className="text-primary">No servers. No middleman.</span>
					</p>
				</div>

				<div className="mx-auto mt-7 max-w-6xl">
					<div className="flex flex-col items-center justify-center gap-4 sm:flex-row">
						<Button
							className="scale-100 font-bold shadow-[0_0_20px_-5px_var(--primary)] transition-[box-shadow,transform] duration-300 hover:scale-105 hover:shadow-[0_0_30px_-5px_var(--primary)]"
							asChild
							onClick={() => play("click")}
						>
							{hasWallet ? (
								<Link href="/wallet">
									<Wallet className="size-6" data-icon="inline-start" /> Browser
									Wallet
								</Link>
							) : (
								<Link href="/wallet">
									<Wallet className="size-6" data-icon="inline-start" /> Choose
									Wallet
								</Link>
							)}
						</Button>
						<Button
							variant="outline"
							className="border-primary/20 bg-background/50 backdrop-blur-sm transition-colors duration-300 hover:border-primary/50 hover:bg-primary/10"
							asChild
							onClick={() => play("click")}
						>
							<Link href="/download">
								Apple App
								<ArrowRight className="ml-2 w-6 h-6" data-icon="inline-end" />
							</Link>
						</Button>
					</div>
				</div>
			</div>

			<Popover>
				<PopoverTrigger asChild>
					<Button
						aria-label="How the P2P trading floor works"
						className="fixed bottom-4 left-16 z-[60] rounded-full border-primary/20 bg-background/70 text-muted-foreground backdrop-blur-sm hover:border-primary/40 hover:bg-background hover:text-foreground"
						size="icon"
						type="button"
						variant="outline"
					>
						<CircleHelp aria-hidden="true" className="size-4" />
					</Button>
				</PopoverTrigger>
				<PopoverContent
					align="start"
					className="z-[70] w-72 border-primary/20 bg-background/95 backdrop-blur-md"
					side="top"
				>
					<PopoverHeader>
						<PopoverTitle>P2P trading floor</PopoverTitle>
						<PopoverDescription className="leading-relaxed">
							Styled pointers belong to other people here. Connect a BRC-100
							wallet, then select a connected peer to request a trade. Guests
							can browse but must connect before trading. Your own pointer stays
							native.
						</PopoverDescription>
					</PopoverHeader>
				</PopoverContent>
			</Popover>

			<div className="absolute inset-0 z-50 pointer-events-none">
				<SharedPresence />
			</div>
			<TradeRequestListener />
		</div>
	);
}
