"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { MnemonicGrid } from "@/components/wallet/mnemonic-grid";
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
		<section className="space-y-6">
			<div className="flex items-center justify-between gap-3">
				<h2 className="font-mono text-xl font-medium">Import Wallet</h2>
			</div>
			<div>
				<Card>
					<CardHeader>
						<CardTitle>Enter Mnemonic Seed</CardTitle>
						<CardDescription>
							Enter your 12-word recovery phrase to import your wallet.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<MnemonicGrid onSubmit={handleMnemonicSubmit} />
						<div className="mt-4 flex justify-start">
							<Button variant="ghost" onClick={() => router.back()}>
								Back
							</Button>
						</div>
					</CardContent>
				</Card>
			</div>
		</section>
	);
}
