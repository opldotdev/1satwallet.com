import type { Metadata } from "next";
import { walletSectionTitle } from "@/lib/wallet-sections";
import { IdentityCenter } from "./identity-center";

export const metadata: Metadata = {
	title: walletSectionTitle("identity"),
};

export default function WalletIdentityPage() {
	return <IdentityCenter />;
}
