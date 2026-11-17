import type { Metadata } from "next";
import HistoryList from "@/components/wallet/history-list";
import { IncomingPayments } from "@/components/wallet/incoming-payments";
import { walletSectionTitle } from "@/lib/wallet-sections";

export const metadata: Metadata = {
	title: walletSectionTitle("history"),
};

export default function WalletHistoryPage() {
	return (
		<section className="space-y-6">
			<IncomingPayments />
			<HistoryList />
		</section>
	);
}
