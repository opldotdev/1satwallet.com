"use client";

import { ChevronRight, FileUp, KeyRound, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Card } from "@/components/ui/card";
import { SectionHeader } from "@/components/ui/section-header";
import { useSound } from "@/hooks/use-sound";
import { useWallet } from "@/providers/wallet-provider";

const SOURCES: readonly {
	href: string;
	icon: LucideIcon;
	title: string;
	description: string;
}[] = [
	{
		href: "/wallet/import/json",
		icon: FileUp,
		title: "Backup file",
		description:
			"Restore from an exported wallet backup (.json, .zip or .bep).",
	},
	{
		href: "/wallet/import/mnemonic",
		icon: KeyRound,
		title: "Recovery phrase",
		description: "Restore from your 12-word seed phrase.",
	},
];

export default function ImportSelectPage() {
	const router = useRouter();
	const { play } = useSound();
	const { hasWallet } = useWallet();

	useEffect(() => {
		if (hasWallet) router.replace("/wallet");
	}, [hasWallet, router]);

	return (
		<section className="mx-auto flex w-full max-w-2xl flex-col gap-4">
			<SectionHeader
				title="Choose what to restore from"
				description="Pick what you saved when you set the wallet up."
			/>
			<div className="grid gap-3 md:grid-cols-2">
				{SOURCES.map(({ href, icon: Icon, title, description }) => (
					<Link
						key={href}
						href={href}
						className="group rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
						onClick={() => play("click")}
					>
						<Card className="h-full flex-row items-center px-(--card-spacing) transition-colors group-hover:bg-accent/50">
							<div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
								<Icon
									aria-hidden="true"
									className="size-5 text-muted-foreground"
								/>
							</div>
							<div className="flex min-w-0 flex-1 flex-col gap-1">
								<p className="font-medium leading-tight">{title}</p>
								<p className="text-muted-foreground text-sm">{description}</p>
							</div>
							<ChevronRight
								aria-hidden="true"
								className="size-5 shrink-0 text-muted-foreground"
							/>
						</Card>
					</Link>
				))}
			</div>
		</section>
	);
}
