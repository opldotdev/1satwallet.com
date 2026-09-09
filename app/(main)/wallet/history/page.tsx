import HistoryList from "@/components/wallet/history-list";

export default function WalletHistoryPage() {
	return (
		<section className="space-y-6">
			<h2 className="font-mono text-xl font-medium">Transaction history</h2>
			<HistoryList />
		</section>
	);
}
