"use client";

import { Mnemonic } from "@bsv/sdk";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MnemonicGrid } from "@/components/wallet/mnemonic-grid";
import { OnboardingStep } from "@/components/wallet/onboarding-step";
import { useWallet } from "@/providers/wallet-provider";
import { useCreateWallet } from "./provider";

const WORD_SLOTS = Array.from({ length: 12 }, (_, slot) => slot);

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
		<OnboardingStep
			step={1}
			total={3}
			title="Your new seed phrase"
			description="Write these 12 words down in order and keep them somewhere safe. Anyone who has them can spend from this wallet."
			actions={
				<Button
					onClick={() => router.push("/wallet/create/confirm")}
					disabled={!mnemonic}
				>
					I have saved my seed phrase
				</Button>
			}
		>
			{mnemonic ? (
				<MnemonicGrid mode="view" mnemonic={mnemonic} />
			) : (
				<div className="grid grid-cols-2 gap-2 md:grid-cols-3">
					{WORD_SLOTS.map((slot) => (
						<Skeleton key={slot} className="h-11 md:h-9" />
					))}
				</div>
			)}
		</OnboardingStep>
	);
}
