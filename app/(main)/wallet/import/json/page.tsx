"use client";

import { Check, FileArchive, Upload, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { OnboardingStep } from "@/components/wallet/onboarding-step";
import { TestnetBadge } from "@/components/wallet/testnet-badge";
import { cn } from "@/lib/utils";
import {
	type DetectedWalletBackup,
	detectWalletBackup,
} from "@/lib/wallet-backup";
import { useImportWallet } from "../provider";

interface PreviewData {
	fileName: string;
	backup: DetectedWalletBackup;
}

export default function ImportJsonPage() {
	const router = useRouter();
	const { setWalletKeys, setEncryptedBackup } = useImportWallet();
	const [previewData, setPreviewData] = useState<PreviewData | null>(null);
	const [isDragging, setIsDragging] = useState(false);
	const [error, setError] = useState("");
	const fileInputRef = useRef<HTMLInputElement>(null);

	const processFile = useCallback(async (file: File) => {
		setError("");
		setPreviewData(null);
		try {
			if (file.size > 16 * 1024 * 1024) {
				throw new Error("Wallet backup exceeds the 16 MiB import limit");
			}
			const backup = detectWalletBackup(
				new Uint8Array(await file.arrayBuffer()),
				file.name,
			);
			setPreviewData({ fileName: file.name, backup });
		} catch (reason) {
			setError(
				reason instanceof Error ? reason.message : "Unsupported backup file",
			);
		}
	}, []);

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (file) void processFile(file);
	};

	const handleDrop = (e: React.DragEvent) => {
		e.preventDefault();
		setIsDragging(false);
		const file = e.dataTransfer.files?.[0];
		if (file) void processFile(file);
	};

	const handleContinue = () => {
		if (!previewData) return;

		if (previewData.backup.kind === "plaintext-keys") {
			setWalletKeys(previewData.backup.keys);
			router.push("/wallet/import/passphrase");
		} else {
			setEncryptedBackup(previewData.backup);
			router.push("/wallet/import/passphrase");
		}
	};

	return (
		<OnboardingStep
			step={1}
			total={2}
			title="Choose a backup file"
			description="Select the wallet backup you exported (.json, .zip or .bep)."
			actions={
				previewData && (
					<Button onClick={handleContinue}>
						<Check data-icon="inline-start" />
						Continue
					</Button>
				)
			}
		>
			<div className="flex flex-col gap-4">
				{previewData ? (
					<div className="flex flex-col gap-3 animate-in fade-in duration-300">
						<div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
							<div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
								<FileArchive
									aria-hidden="true"
									className="size-5 text-muted-foreground"
								/>
							</div>
							<div className="flex min-w-0 flex-1 flex-col gap-1">
								<p className="truncate font-medium">{previewData.fileName}</p>
								<div className="flex flex-wrap items-center gap-2">
									<Badge variant="outline">{previewData.backup.label}</Badge>
									{previewData.backup.kind === "yours-keys" && (
										<Badge variant="secondary">Yours Wallet</Badge>
									)}
									{previewData.backup.network === "test" && <TestnetBadge />}
								</div>
							</div>
							<Button
								aria-label="Remove selected backup"
								variant="ghost"
								size="icon"
								onClick={() => setPreviewData(null)}
								className="shrink-0 text-muted-foreground hover:text-destructive"
							>
								<X />
							</Button>
						</div>
						<Notice>
							{previewData.backup.requiresPassword
								? "The file is decrypted and checked before the wallet on this device is replaced."
								: "This older file carries its own decryption key. It is still checked before import."}
						</Notice>
					</div>
				) : (
					<Button
						variant="outline"
						type="button"
						onClick={() => fileInputRef.current?.click()}
						onDragOver={(e) => {
							e.preventDefault();
							setIsDragging(true);
						}}
						onDragLeave={(e) => {
							e.preventDefault();
							setIsDragging(false);
						}}
						onDrop={handleDrop}
						className={cn(
							"h-auto w-full flex-col gap-3 whitespace-normal rounded-lg border-dashed p-6 transition-colors",
							isDragging && "border-primary bg-primary/10",
						)}
					>
						<div
							className={cn(
								"flex size-12 items-center justify-center rounded-full transition-colors",
								isDragging ? "bg-primary/20" : "bg-muted",
							)}
						>
							{isDragging ? (
								<FileArchive className="size-6 text-primary" />
							) : (
								<Upload className="size-6 text-muted-foreground" />
							)}
						</div>
						<span className="flex flex-col gap-1 text-center">
							<span className="text-sm font-medium text-foreground">
								{isDragging ? "Drop the file here" : "Choose a backup file"}
							</span>
							<span className="text-muted-foreground text-xs font-normal">
								or drop it here
							</span>
						</span>
					</Button>
				)}
				{error && (
					<p className="text-sm text-destructive" role="alert">
						{error}
					</p>
				)}
				<input
					aria-label="Wallet backup file"
					ref={fileInputRef}
					type="file"
					className="sr-only"
					accept=".json,.zip,.bep,application/json,application/zip,text/plain"
					onChange={handleFileChange}
				/>
			</div>
		</OnboardingStep>
	);
}
