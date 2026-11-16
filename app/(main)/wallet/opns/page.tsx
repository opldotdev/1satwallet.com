import type { Metadata } from "next";
import { OwnedOpns } from "@/components/opns/owned-opns";
import { walletSectionTitle } from "@/lib/wallet-sections";

export const metadata: Metadata = {
	title: walletSectionTitle("opns"),
};

export default function WalletOpnsPage() {
	return <OwnedOpns />;
}
