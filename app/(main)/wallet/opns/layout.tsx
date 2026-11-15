import { MainnetOnly } from "@/components/mainnet-only";

export default function WalletOpnsLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return <MainnetOnly>{children}</MainnetOnly>;
}
