"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NetworkChoice } from "@/components/wallet/network-choice";
import { OnboardingStep } from "@/components/wallet/onboarding-step";
import type { Chain } from "@/lib/chain-endpoints";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import {
	backupRestoreErrorMessage,
	classifyBackupRestoreError,
	decryptWalletBackup,
	keysNetworkHint,
} from "@/lib/wallet-backup";
import { useWallet } from "@/providers/wallet-provider";
import { useImportWallet } from "../provider";

const TESTNET_HINT =
	"These keys are encoded for testnet, so Testnet is selected.";
const CHAIN_NAME: Record<Chain, string> = { main: "Mainnet", test: "Testnet" };

export default function ImportPassphrasePage() {
	const router = useRouter();
	const { hasWallet, importWallet } = useWallet();
	const { walletKeys, setWalletKeys, encryptedBackup } = useImportWallet();
	const [passphrase, setPassphrase] = useState("");
	const [localPassphrase, setLocalPassphrase] = useState("");
	const [confirmPassphrase, setConfirmPassphrase] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const [error, setError] = useState("");

	const mode = encryptedBackup ? "decrypt" : "encrypt";
	const requiresPassword = encryptedBackup?.requiresPassword ?? true;
	// A backup that names its network decides it; otherwise the person does,
	// with Testnet preselected only when every visible key is testnet-encoded.
	const fixedNetwork = encryptedBackup?.network ?? null;
	const visibleHint =
		encryptedBackup?.hintedNetwork ??
		(walletKeys && !encryptedBackup ? keysNetworkHint(walletKeys) : null);
	const [network, setNetwork] = useState<Chain>(
		visibleHint === "test" ? "test" : "main",
	);
	const [networkNote, setNetworkNote] = useState<string | undefined>(
		visibleHint === "test" ? TESTNET_HINT : undefined,
	);
	const [hintShown, setHintShown] = useState(visibleHint === "test");

	// Once a wallet is saved, this flow is over: an import onto the other
	// network remounts this page with empty import state, which must lead to
	// the wallet, not back to the start of the import.
	useEffect(() => {
		if (hasWallet) {
			router.replace("/wallet");
			return;
		}
		if (!walletKeys && !encryptedBackup) {
			router.replace("/wallet/import");
		}
	}, [hasWallet, walletKeys, encryptedBackup, router]);

	if (hasWallet || (!walletKeys && !encryptedBackup)) return null;

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError("");

		if (mode === "encrypt") {
			if (!walletKeys || !passphrase || passphrase !== confirmPassphrase)
				return;

			setIsSaving(true);
			const success = await importWallet(walletKeys, passphrase, network);
			setIsSaving(false);

			if (!success) {
				setError("Could not save the wallet in this browser. Try again.");
			}
		} else {
			if (
				!encryptedBackup ||
				(requiresPassword && !passphrase) ||
				!localPassphrase ||
				localPassphrase !== confirmPassphrase
			)
				return;
			setIsSaving(true);

			try {
				const decrypted = await decryptWalletBackup(
					encryptedBackup,
					requiresPassword ? passphrase : "",
				);
				// Keys seen only after decryption can still hint at testnet: select
				// it and let the person confirm before anything is saved.
				if (
					decrypted.network === null &&
					decrypted.hintedNetwork === "test" &&
					network === "main" &&
					!hintShown
				) {
					setNetwork("test");
					setNetworkNote(TESTNET_HINT);
					setHintShown(true);
					setError("Check the network, then import again.");
					return;
				}
				const finalNetwork = decrypted.network ?? network;
				setWalletKeys(decrypted.keys);
				const success = await importWallet(
					decrypted.keys,
					localPassphrase,
					finalNetwork,
				);
				if (!success) {
					// importWallet reported the cause.
					setError("Could not save the wallet in this browser. Try again.");
					return;
				}
				if (fixedNetwork === null && finalNetwork !== network) {
					toast("Imported as a testnet account, as the backup says.");
				}
			} catch (err) {
				const failure = classifyBackupRestoreError(err);
				reportDiagnostic({
					category: "action",
					code: "action.failed",
					operation: "wallet.import.restore",
					recoverable: true,
					context: { status: failure, retryable: true },
				});
				setError(backupRestoreErrorMessage(failure, requiresPassword));
			} finally {
				setIsSaving(false);
			}
		}
	};

	const passwordToMatch = mode === "encrypt" ? passphrase : localPassphrase;

	return (
		<OnboardingStep
			step={2}
			total={2}
			title={
				mode === "encrypt"
					? "Set a password"
					: requiresPassword
						? "Unlock your backup"
						: "Set a wallet password"
			}
			description={
				mode === "encrypt"
					? "It encrypts the wallet on this device. You enter it to unlock."
					: requiresPassword
						? "Enter the backup's password, then choose a password for this device."
						: "This older backup carries its own decryption key. Set a password to protect it on this device."
			}
			form={{ onSubmit: handleSubmit }}
			actions={
				<>
					<Button variant="outline" onClick={() => router.back()} type="button">
						Back
					</Button>
					<Button
						type="submit"
						disabled={
							(mode === "encrypt"
								? !passphrase || passphrase !== confirmPassphrase
								: (requiresPassword && !passphrase) ||
									!localPassphrase ||
									localPassphrase !== confirmPassphrase) || isSaving
						}
					>
						{isSaving && (
							<Loader2 className="animate-spin" data-icon="inline-start" />
						)}
						{mode === "encrypt"
							? "Encrypt & Save"
							: requiresPassword
								? "Decrypt & Import"
								: "Encrypt & Restore"}
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-4">
				{(mode === "encrypt" || requiresPassword) && (
					<div className="grid gap-2">
						<Label htmlFor="passphrase">
							{mode === "encrypt" ? "Password" : "Backup Password"}
						</Label>
						<Input
							autoComplete={
								mode === "encrypt" ? "new-password" : "current-password"
							}
							id="passphrase"
							type="password"
							value={passphrase}
							onChange={(e) => setPassphrase(e.target.value)}
							required
							minLength={mode === "encrypt" ? 6 : 1}
						/>
					</div>
				)}

				{mode === "decrypt" && (
					<div className="grid gap-2">
						<Label htmlFor="local-passphrase">Wallet Password</Label>
						<Input
							autoComplete="new-password"
							id="local-passphrase"
							type="password"
							value={localPassphrase}
							onChange={(e) => setLocalPassphrase(e.target.value)}
							required
							minLength={6}
						/>
					</div>
				)}

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
					{passwordToMatch &&
						confirmPassphrase &&
						passwordToMatch !== confirmPassphrase && (
							<p className="text-sm text-destructive">Passwords do not match</p>
						)}
				</div>

				{fixedNetwork === "main" ? null : fixedNetwork ? (
					<p className="text-xs text-muted-foreground">
						Network: {CHAIN_NAME[fixedNetwork]}. Set by this backup.
					</p>
				) : (
					<NetworkChoice
						value={network}
						onChange={(next) => {
							setNetwork(next);
							setNetworkNote(undefined);
						}}
						note={networkNote}
					/>
				)}

				{error && (
					<p className="text-sm text-destructive" role="alert">
						{error}
					</p>
				)}
			</div>
		</OnboardingStep>
	);
}
