import type { Metadata } from "next";
import { OrdinalsGrid } from "@/components/wallet/ordinals-grid";
import { walletSectionTitle } from "@/lib/wallet-sections";

export const metadata: Metadata = {
	title: walletSectionTitle("ordinals"),
};

export default function WalletOrdinalsPage() {
	return <OrdinalsGrid />;
}
