import type { Metadata } from "next";
import { Bsv21Deploy } from "@/components/wallet/bsv21-deploy";
import TokenGrid from "@/components/wallet/token-grid";
import { walletSectionTitle } from "@/lib/wallet-sections";

export const metadata: Metadata = {
	title: walletSectionTitle("bsv21"),
};

export default function WalletBsv21Page() {
	return (
		<div className="space-y-6">
			<TokenGrid />
			<Bsv21Deploy />
		</div>
	);
}
