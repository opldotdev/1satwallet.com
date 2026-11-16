import type { Metadata } from "next";
import { WalletHome } from "@/components/wallet/wallet-home";
import { walletSectionTitle } from "@/lib/wallet-sections";

export const metadata: Metadata = {
	title: walletSectionTitle("overview"),
};

export default function WalletPage() {
	return <WalletHome />;
}
