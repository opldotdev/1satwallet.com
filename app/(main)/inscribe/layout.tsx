import { MainnetOnly } from "@/components/mainnet-only";

export default function InscribeLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return <MainnetOnly>{children}</MainnetOnly>;
}
