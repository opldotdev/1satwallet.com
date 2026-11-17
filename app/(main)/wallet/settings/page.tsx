import type { Metadata } from "next";
import { WalletSettingsForm } from "@/components/wallet/wallet-settings-form";
import { walletSubPageTitle } from "@/lib/wallet-sections";

// The wallet header carries the title and the back arrow to Settings.
export const metadata: Metadata = {
	title: walletSubPageTitle("/wallet/settings"),
};

export default function WalletSettingsPage() {
	return <WalletSettingsForm />;
}
