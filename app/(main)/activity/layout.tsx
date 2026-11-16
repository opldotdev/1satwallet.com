import { MainnetOnly } from "@/components/mainnet-only";

export default function ActivityLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return <MainnetOnly>{children}</MainnetOnly>;
}
