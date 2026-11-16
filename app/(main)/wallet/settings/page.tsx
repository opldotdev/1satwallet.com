import type { Metadata } from "next";
import { WalletSettingsForm } from "@/components/wallet/wallet-settings-form";

// The wallet header carries the title and the back arrow to Settings.
export const metadata: Metadata = {
	title: "Wallet settings - 1Sat",
};

export default function WalletSettingsPage() {
	return <WalletSettingsForm />;
}
