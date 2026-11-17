"use client";

import { Loader2, Lock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { useWallet, WalletSaveError } from "@/providers/wallet-provider";

export function FullScreenUnlock() {
	const { isWalletLocked, isWalletInitialized, unlockWallet, hasWallet } =
		useWallet();
	const [passphrase, setPassphrase] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (isWalletLocked && hasWallet && inputRef.current) {
			inputRef.current.focus();
		}
	}, [isWalletLocked, hasWallet]);

	const handleUnlock = async (e: React.FormEvent) => {
		e.preventDefault();
		setIsLoading(true);
		setError("");

		try {
			if (!(await unlockWallet(passphrase))) {
				setError("Invalid passphrase");
			}
		} catch (error) {
			console.error("[wallet.unlock]", error);
			setError(
				error instanceof WalletSaveError
					? error.message
					: "Wallet could not be unlocked. Try again.",
			);
		} finally {
			setIsLoading(false);
		}
	};

	if (!isWalletInitialized) return null;
	if (!hasWallet) return null; // Don't show if no wallet
	if (!isWalletLocked) return null; // Don't show if unlocked

	// A bottom sheet on phones (above the home indicator), a centered card
	// from sm.
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Unlock wallet"
			className="fixed inset-0 z-[120] flex h-dvh items-end justify-center bg-background/80 pt-[env(safe-area-inset-top)] backdrop-blur-sm sm:items-center sm:pr-[env(safe-area-inset-right)] sm:pb-[env(safe-area-inset-bottom)] sm:pl-[env(safe-area-inset-left)]"
		>
			<Card className="w-full animate-in border-border/50 bg-card/95 shadow-2xl backdrop-blur duration-300 supports-[backdrop-filter]:bg-card/75 max-sm:rounded-b-none max-sm:border-b-0 max-sm:pb-[max(var(--card-spacing),env(safe-area-inset-bottom))] max-sm:slide-in-from-bottom sm:max-w-md sm:fade-in sm:zoom-in-95">
				<CardHeader className="justify-items-center text-center">
					<div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
						<Lock aria-hidden="true" className="size-6 text-primary" />
					</div>
					<CardTitle className="text-lg">Unlock wallet</CardTitle>
					<CardDescription>Enter your passphrase to continue.</CardDescription>
				</CardHeader>
				<CardContent>
					<form className="flex flex-col gap-4" onSubmit={handleUnlock}>
						<div className="flex flex-col gap-2">
							<Label htmlFor="passphrase">Passphrase</Label>
							<Input
								aria-describedby={error ? "passphrase-error" : undefined}
								aria-invalid={error ? true : undefined}
								autoComplete="current-password"
								disabled={isLoading}
								id="passphrase"
								onChange={(e) => {
									setPassphrase(e.target.value);
									setError("");
								}}
								ref={inputRef}
								type="password"
								value={passphrase}
							/>
							{error && (
								<p
									className="text-destructive text-sm"
									id="passphrase-error"
									role="alert"
								>
									{error}
								</p>
							)}
						</div>
						<Button
							className="w-full"
							disabled={isLoading || !passphrase}
							size="lg"
							type="submit"
						>
							{isLoading && (
								<Loader2 className="animate-spin" data-icon="inline-start" />
							)}
							{isLoading ? "Unlocking…" : "Unlock"}
						</Button>
					</form>
				</CardContent>
			</Card>
		</div>
	);
}
