import type { Metadata } from "next";
import { NotOnTestnet } from "@/components/not-on-testnet";

// The proxy serves this page in place of mainnet-only pages on testnet.
export const metadata: Metadata = {
	title: "Not available on testnet - 1Sat",
	robots: { index: false, follow: false },
};

export default function NotOnTestnetPage() {
	return <NotOnTestnet />;
}
