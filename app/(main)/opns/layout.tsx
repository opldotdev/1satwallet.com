import { MainnetOnly } from "@/components/mainnet-only";

export default function OpnsLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return <MainnetOnly>{children}</MainnetOnly>;
}
