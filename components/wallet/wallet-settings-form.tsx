"use client";

import {
	Bug,
	Cable,
	Coins,
	Database,
	Eye,
	EyeOff,
	Globe,
	Inbox,
	Loader2,
	LogOut,
	RefreshCw,
	Shield,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { SettingsGroup, SettingsRow } from "@/components/settings/settings-row";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { MessageboxReceiving } from "@/components/wallet/messagebox-receiving";
import { TestnetBadge } from "@/components/wallet/testnet-badge";
import { useSound } from "@/hooks/use-sound";
import { CURRENCY_KEY, PRIVACY_MODE_KEY } from "@/lib/constants";
import { walletStorageHost } from "@/lib/wallet/storage-endpoint";
import { useSettingsStorage } from "@/lib/wallet-storage";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

export function WalletSettingsForm() {
	const { play } = useSound();
	const {
		syncWallet,
		hasActiveSync: isSyncing,
		isInitialized,
		connectionMode,
		providerType,
		disconnectExternalWallet,
		chain,
	} = useWalletToolbox();
	const storageHost = walletStorageHost(chain);
	const [isPrivacyModeEnabled, setIsPrivacyModeEnabled] =
		useSettingsStorage<boolean>(PRIVACY_MODE_KEY, false);
	const [currency, setCurrency] = useSettingsStorage<string>(
		CURRENCY_KEY,
		"USD",
	);
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		setMounted(true);
	}, []);

	if (!mounted) return null;

	return (
		<div className="flex flex-col gap-6">
			<SettingsGroup title="Connection">
				{connectionMode === "external" ? (
					<SettingsRow
						icon={Cable}
						title="Wallet connection"
						description={`Connected through ${providerType ?? "a BRC-100 provider"}.`}
						action={
							<Button
								onClick={() => void disconnectExternalWallet()}
								variant="outline"
							>
								<LogOut data-icon="inline-start" />
								Disconnect
							</Button>
						}
					/>
				) : (
					<SettingsRow
						icon={Database}
						title="Wallet storage"
						description={
							<>
								Using the wallet built into this browser. Active store:{" "}
								<code className="break-all font-mono">{storageHost}</code>. A
								copy in this browser is kept in sync as a backup.
							</>
						}
					/>
				)}
				{connectionMode === "built-in" && (
					<SettingsRow icon={Inbox}>
						{/* Its own label is text-base; rows title at text-sm. */}
						<div className="[&_[data-slot=label]]:text-sm">
							<MessageboxReceiving />
						</div>
					</SettingsRow>
				)}
			</SettingsGroup>

			<SettingsGroup title="Preferences">
				{/* Network: fixed per account, never a setting */}
				<SettingsRow
					icon={Globe}
					title="Network"
					description={
						connectionMode === "external"
							? "Reported by the connected wallet."
							: "Set when this wallet was created or imported. It cannot be changed."
					}
					control={
						chain === "test" ? (
							<TestnetBadge />
						) : (
							<span className="text-sm font-medium">Mainnet</span>
						)
					}
				/>
				<SettingsRow
					icon={Coins}
					title="Display currency"
					description="The currency fiat values are shown in."
					htmlFor="currency"
					action={
						<Select
							value={currency}
							onValueChange={(v) => {
								play("click");
								setCurrency(v);
							}}
						>
							<SelectTrigger id="currency">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="USD">USD</SelectItem>
								<SelectItem value="BSV">BSV</SelectItem>
							</SelectContent>
						</Select>
					}
				/>
				<SettingsRow
					icon={isPrivacyModeEnabled ? EyeOff : Eye}
					title="Privacy mode"
					description="Hide balances by default in the sidebar and dashboard."
					htmlFor="privacy"
					control={
						<Switch
							id="privacy"
							checked={isPrivacyModeEnabled}
							onCheckedChange={(v) => {
								play("click");
								setIsPrivacyModeEnabled(v);
							}}
						/>
					}
				/>
				<SettingsRow
					icon={RefreshCw}
					title="Blockchain sync"
					description="Refresh your spendable balance and indexed assets now."
					action={
						<Button
							variant="outline"
							onClick={() => {
								play("click");
								syncWallet();
							}}
							disabled={!isInitialized || isSyncing}
						>
							{isSyncing ? (
								<Loader2 className="animate-spin" data-icon="inline-start" />
							) : (
								<RefreshCw data-icon="inline-start" />
							)}
							{isSyncing ? "Syncing…" : "Sync now"}
						</Button>
					}
				/>
				{connectionMode === "built-in" && (
					<SettingsRow
						icon={Shield}
						title="Connected apps"
						description="Review and revoke what external apps may do."
						action={
							<Button variant="outline" asChild onClick={() => play("click")}>
								<Link href="/wallet/permissions">Manage</Link>
							</Button>
						}
					/>
				)}
			</SettingsGroup>

			<SettingsGroup title="Developer">
				<SettingsRow
					icon={Bug}
					title="Wallet diagnostics"
					description="View wallet state, test integrations and debug issues."
					action={
						<Button variant="outline" asChild onClick={() => play("click")}>
							<Link href="/wallet/diagnostics">Open</Link>
						</Button>
					}
				/>
			</SettingsGroup>

			{connectionMode === "built-in" && (
				<SettingsGroup title="Danger zone" danger>
					<SettingsRow
						icon={LogOut}
						title="Sign out"
						description="Remove this wallet from the browser. Make sure your recovery phrase is backed up first."
						action={
							<Button
								variant="destructive"
								asChild
								onClick={() => play("click")}
							>
								<Link href="/wallet/delete">Sign out</Link>
							</Button>
						}
					/>
				</SettingsGroup>
			)}
		</div>
	);
}
