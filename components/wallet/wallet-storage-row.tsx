"use client";

import { Database, Loader2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { SettingsRow } from "@/components/settings/settings-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import {
	defaultWalletStorageUrl,
	storageHostOf,
	walletStorageHost,
} from "@/lib/wallet/storage-endpoint";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

/**
 * The built-in wallet's storage provider: the server that keeps its data and
 * broadcasts its transactions. Shows the active provider and lets the user
 * move the wallet to another one, or follow a move made on another device.
 */
export function WalletStorageRow() {
	const {
		chain,
		identityKey,
		storageStatus,
		canChangeWalletStorage,
		changeWalletStorage,
	} = useWalletToolbox();
	const [open, setOpen] = useState(false);
	const [address, setAddress] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const defaultUrl = defaultWalletStorageUrl(chain);
	const activeUrl = storageStatus ? storageStatus.activeRemoteUrl : undefined;
	const host = storageStatus
		? activeUrl
			? storageHostOf(activeUrl)
			: "this browser"
		: walletStorageHost(chain, identityKey ?? undefined);
	const moved = Boolean(storageStatus?.movedTo);
	const readOnly = storageStatus ? !storageStatus.writable : false;

	const openDialog = () => {
		setAddress(moved ? "" : (activeUrl ?? defaultUrl));
		setError(null);
		setOpen(true);
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			await changeWalletStorage(address);
			setOpen(false);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<SettingsRow
				icon={Database}
				title="Wallet storage"
				description={
					<>
						Your wallet's data is kept, and its transactions broadcast, by{" "}
						<code className="break-all font-mono">{host}</code>. A copy in this
						browser is kept in sync as a backup.
					</>
				}
				control={
					readOnly ? <Badge variant="outline">Read-only</Badge> : undefined
				}
				action={
					canChangeWalletStorage ? (
						<Button onClick={openDialog} variant="outline">
							{moved ? "Add provider" : "Change"}
						</Button>
					) : undefined
				}
			/>
			{moved && (
				<div className="py-3">
					<Notice tone="warning" title="Your wallet moved on another device">
						It now uses a storage provider this browser doesn't know. Until you
						add it here, balances may be out of date and sending is off.
					</Notice>
				</div>
			)}
			<Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
				<DialogContent showCloseButton={!busy}>
					<form className="flex flex-col gap-4" onSubmit={submit}>
						<DialogHeader>
							<DialogTitle>
								{moved ? "Add your wallet's storage" : "Change wallet storage"}
							</DialogTitle>
							<DialogDescription>
								{moved
									? "Enter the storage provider address your other device uses."
									: "Choose the server that keeps this wallet's data and broadcasts its transactions."}
							</DialogDescription>
						</DialogHeader>
						<div className="flex flex-col gap-2">
							<Label htmlFor="wallet-storage-url">Provider address</Label>
							<Input
								id="wallet-storage-url"
								inputMode="url"
								autoComplete="off"
								spellCheck={false}
								placeholder="https://"
								value={address}
								onChange={(e) => setAddress(e.target.value)}
								disabled={busy}
							/>
							{!moved && address.trim() !== defaultUrl && (
								<Button
									type="button"
									variant="link"
									className="self-start px-0"
									onClick={() => setAddress(defaultUrl)}
									disabled={busy}
								>
									Use the 1Sat default ({storageHostOf(defaultUrl)})
								</Button>
							)}
						</div>
						{!moved && (
							<Notice tone="warning">
								The provider you pick holds your wallet's history and sends your
								transactions, so only use one you trust. Your keys stay in this
								browser. Your other devices follow the move when they next open.
							</Notice>
						)}
						{error && <Notice tone="danger">{error}</Notice>}
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => setOpen(false)}
								disabled={busy}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								disabled={
									busy ||
									!address.trim() ||
									(!moved && address.trim() === activeUrl)
								}
							>
								{busy && (
									<Loader2 className="animate-spin" data-icon="inline-start" />
								)}
								{moved ? "Add provider" : "Switch"}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
