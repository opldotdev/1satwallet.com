import { MainnetOnly } from "@/components/mainnet-only";

export default function WalletMigrateLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return <MainnetOnly>{children}</MainnetOnly>;
}
