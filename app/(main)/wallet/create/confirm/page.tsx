"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MnemonicGrid } from "@/components/wallet/mnemonic-grid";
import { OnboardingStep } from "@/components/wallet/onboarding-step";
import { useCreateWallet } from "../provider";

export default function ConfirmWalletPage() {
	const router = useRouter();
	const { mnemonic } = useCreateWallet();
	const [isVerified, setIsVerified] = useState(false);

	if (!mnemonic) {
		if (typeof window !== "undefined") router.replace("/wallet/create");
		return null;
	}

	return (
		<OnboardingStep
			step={2}
			total={3}
			title="Confirm your seed phrase"
			description="Enter the words at these positions to show you saved them."
			actions={
				<>
					<Button variant="outline" onClick={() => router.back()}>
						Back
					</Button>
					<Button
						onClick={() => router.push("/wallet/create/encrypt")}
						disabled={!isVerified}
					>
						Confirm & Continue
					</Button>
				</>
			}
		>
			<MnemonicGrid
				mode="spot-check"
				mnemonic={mnemonic}
				onVerify={(isValid) => setIsVerified(isValid)}
			/>
		</OnboardingStep>
	);
}
