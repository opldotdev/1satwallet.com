import { Page } from "@/components/page-layout";
import { WalletHeader } from "@/components/wallet/wallet-header";
import { WalletTabs } from "@/components/wallet/wallet-tabs";

export default function WalletLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<Page>
			<WalletHeader />
			<WalletTabs />
			<div className="min-w-0 space-y-6">{children}</div>
		</Page>
	);
}
