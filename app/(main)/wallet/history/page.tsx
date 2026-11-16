import HistoryList from "@/components/wallet/history-list";
import { IncomingPayments } from "@/components/wallet/incoming-payments";

export default function WalletHistoryPage() {
	return (
		<section className="space-y-6">
			<IncomingPayments />
			<h2 className="font-mono text-xl font-medium">Transaction history</h2>
			<HistoryList />
		</section>
	);
}
