import { MainnetOnly } from "@/components/mainnet-only";

export default function WalletSweepLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return <MainnetOnly>{children}</MainnetOnly>;
}
