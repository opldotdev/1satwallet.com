import type { Metadata } from "next";
import { CertificateCenter } from "@/components/wallet/certificate-center";
import { walletSectionTitle } from "@/lib/wallet-sections";

export const metadata: Metadata = {
	title: walletSectionTitle("certificates"),
};

export default function WalletCertificatesPage() {
	return <CertificateCenter />;
}
