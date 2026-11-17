import { UnderPageHeading } from "@/components/not-on-testnet";
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
			{/* The header is the page's h1, so notices inside use an h2. */}
			<UnderPageHeading>
				<div className="min-w-0 space-y-6">{children}</div>
			</UnderPageHeading>
		</Page>
	);
}
