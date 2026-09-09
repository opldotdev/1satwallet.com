"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { WalletSettingsForm } from "@/components/wallet/wallet-settings-form";
import { useSound } from "@/hooks/use-sound";

export default function WalletSettingsPage() {
	const { play } = useSound();

	return (
		<section className="space-y-6">
			<div className="flex items-center gap-2 justify-start">
				<Button
					variant="ghost"
					size="icon"
					asChild
					className="-ml-2"
					onClick={() => play("click")}
				>
					<Link href="/settings">
						<span className="sr-only">Back to settings</span>
						<ArrowLeft className="h-4 w-4" />
					</Link>
				</Button>
				<h2 className="font-mono text-xl font-medium">Wallet Settings</h2>
			</div>
			<div>
				<WalletSettingsForm />
			</div>
		</section>
	);
}
