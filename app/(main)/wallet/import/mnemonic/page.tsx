"use client";

import { useRouter } from "next/navigation";
import { MnemonicGrid } from "@/components/wallet/mnemonic-grid";
import { OnboardingStep } from "@/components/wallet/onboarding-step";
import type { Keys } from "@/lib/types";
import { useImportWallet } from "../provider";

export default function ImportMnemonicPage() {
	const router = useRouter();
	const { setWalletKeys } = useImportWallet();

	const handleMnemonicSubmit = (keys: Keys) => {
		setWalletKeys(keys);
		router.push("/wallet/import/passphrase");
	};

	return (
		<OnboardingStep
			step={1}
			total={2}
			title="Enter your recovery phrase"
			description="Type or paste the 12 words in order."
		>
			<MnemonicGrid onSubmit={handleMnemonicSubmit} />
		</OnboardingStep>
	);
}
