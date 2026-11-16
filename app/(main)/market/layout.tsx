import { MainnetOnly } from "@/components/mainnet-only";

export default function MarketLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return <MainnetOnly>{children}</MainnetOnly>;
}
