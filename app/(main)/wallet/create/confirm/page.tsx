"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { MnemonicGrid } from "@/components/wallet/mnemonic-grid";
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
		<section className="space-y-6">
			<div className="flex items-center justify-between gap-3">
				<h2 className="font-mono text-xl font-medium">Create New Wallet</h2>
			</div>
			<div>
				<Card>
					<CardHeader>
						<CardTitle>Confirm Seed Phrase</CardTitle>
						<CardDescription>
							Verify you saved your seed phrase by entering the words at the
							positions shown below.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<MnemonicGrid
							mode="spot-check"
							mnemonic={mnemonic}
							onVerify={(isValid) => setIsVerified(isValid)}
						/>
						<div className="flex gap-2 mt-4 justify-end">
							<Button variant="ghost" onClick={() => router.back()}>
								Back
							</Button>
							<Button
								onClick={() => router.push("/wallet/create/encrypt")}
								disabled={!isVerified}
							>
								Confirm & Continue
							</Button>
						</div>
					</CardContent>
				</Card>
			</div>
		</section>
	);
}
