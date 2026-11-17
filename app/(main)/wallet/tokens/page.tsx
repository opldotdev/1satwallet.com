import type { Metadata } from "next";
import { TokensSection } from "@/components/wallet/tokens-section";
import { walletSectionTitle } from "@/lib/wallet-sections";

export const metadata: Metadata = {
	title: walletSectionTitle("tokens"),
};

export default function WalletTokensPage() {
	return <TokensSection />;
}
