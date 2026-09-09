"use client";

import { Mnemonic } from "@bsv/sdk";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { MnemonicGrid } from "@/components/wallet/mnemonic-grid";
import { useWallet } from "@/providers/wallet-provider";
import { useCreateWallet } from "./provider";

export default function GenerateWalletPage() {
	const router = useRouter();
	const { mnemonic, setMnemonic } = useCreateWallet();
	const { hasWallet } = useWallet();

	useEffect(() => {
		if (hasWallet) {
			router.push("/wallet");
			return;
		}
		if (!mnemonic) {
			setMnemonic(Mnemonic.fromRandom(128).toString());
		}
	}, [mnemonic, setMnemonic, hasWallet, router]);

	return (
		<section className="space-y-6">
			<div className="flex items-center justify-between gap-3">
				<h2 className="font-mono text-xl font-medium">Create New Wallet</h2>
			</div>
			<div>
				<Card>
					<CardHeader>
						<CardTitle>Your New Seed Phrase</CardTitle>
						<CardDescription>
							Write down these 12 words in order and store them safely.
						</CardDescription>
					</CardHeader>
					<CardContent>
						{mnemonic ? (
							<MnemonicGrid mode="view" mnemonic={mnemonic} />
						) : (
							<div className="flex items-center justify-center py-8">
								<Loader2 className="animate-spin h-8 w-8 text-muted-foreground" />
							</div>
						)}
						<div className="mt-6 flex justify-end">
							<Button
								onClick={() => router.push("/wallet/create/confirm")}
								disabled={!mnemonic}
							>
								I have saved my seed phrase
							</Button>
						</div>
					</CardContent>
				</Card>
			</div>
		</section>
	);
}
