"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import type React from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NetworkChoice } from "@/components/wallet/network-choice";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import { useWallet } from "@/providers/wallet-provider";
import { useCreateWallet } from "../provider";

export default function EncryptWalletPage() {
	const router = useRouter();
	const { createWallet } = useWallet(); // Global wallet action
	const { mnemonic, setMnemonic, network, setNetwork } = useCreateWallet(); // Local wizard state
	const [passphrase, setPassphrase] = useState("");
	const [confirmPassphrase, setConfirmPassphrase] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState("");

	if (!mnemonic) {
		if (typeof window !== "undefined") router.replace("/wallet/create");
		return null;
	}

	const handleCreateWallet = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!mnemonic || !passphrase || passphrase !== confirmPassphrase) return;

		setIsLoading(true);
		setError("");
		try {
			const success = await createWallet(mnemonic, passphrase, network);
			if (success) {
				setMnemonic(null); // Clear local state
				// Note: createWallet already navigates to /wallet on success
			} else {
				setError("Could not save the wallet in this browser. Try again.");
				reportDiagnostic({
					category: "action",
					code: "action.failed",
					operation: "wallet.create",
					recoverable: true,
				});
			}
		} finally {
			setIsLoading(false);
		}
	};

	return (
		<section className="space-y-6">
			<div className="flex items-center justify-between gap-3">
				<h2 className="font-mono text-xl font-medium">Create New Wallet</h2>
			</div>
			<div>
				<Card>
					<CardHeader>
						<CardTitle>Set Password</CardTitle>
						<CardDescription>
							Set a secure password to encrypt your wallet.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<form onSubmit={handleCreateWallet} className="space-y-4">
							<div className="grid gap-2">
								<Label htmlFor="passphrase">Password</Label>
								<Input
									autoComplete="new-password"
									id="passphrase"
									type="password"
									value={passphrase}
									onChange={(e) => setPassphrase(e.target.value)}
									required
									minLength={6}
								/>
							</div>
							<div className="grid gap-2">
								<Label htmlFor="confirm-passphrase">Confirm Password</Label>
								<Input
									autoComplete="new-password"
									id="confirm-passphrase"
									type="password"
									value={confirmPassphrase}
									onChange={(e) => setConfirmPassphrase(e.target.value)}
									required
									minLength={6}
								/>
								{passphrase &&
									confirmPassphrase &&
									passphrase !== confirmPassphrase && (
										<p className="text-sm text-destructive">
											Passwords do not match
										</p>
									)}
							</div>
							<NetworkChoice value={network} onChange={setNetwork} />
							{error && (
								<p className="text-sm text-destructive" role="alert">
									{error}
								</p>
							)}
							<div className="flex gap-2">
								<Button
									aria-live="polite"
									variant="outline"
									onClick={() => router.back()}
									type="button"
								>
									Back
								</Button>
								<Button
									type="submit"
									className="flex-1"
									disabled={
										!passphrase || passphrase !== confirmPassphrase || isLoading
									}
								>
									{isLoading ? (
										<Loader2 className="animate-spin" />
									) : (
										"Encrypt & Save"
									)}
								</Button>
							</div>
						</form>
					</CardContent>
				</Card>
			</div>
		</section>
	);
}
