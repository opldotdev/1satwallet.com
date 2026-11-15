import type { Metadata } from "next";
import { NotOnTestnetRoute } from "@/components/not-on-testnet-route";

// The proxy serves this page in place of mainnet-only pages on testnet.
export const metadata: Metadata = {
	title: "Not available on testnet - 1Sat",
	robots: { index: false, follow: false },
};

export default function NotOnTestnetPage() {
	return <NotOnTestnetRoute />;
}
