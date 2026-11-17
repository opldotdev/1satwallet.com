import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Bsv21Detail from "@/components/wallet/bsv21-detail";
import {
	isBsv21TokenId,
	normalizeBsv21TokenId,
} from "@/lib/wallet/bsv21-actions";
import { walletSubPageTitle } from "@/lib/wallet-sections";

interface Bsv21TokenPageProps {
	params: Promise<{ tokenId: string }>;
}

export const metadata: Metadata = {
	title: walletSubPageTitle("/wallet/bsv21/token"),
};

/** One BSV-21 token in this wallet, a sub-page of Tokens. */
export default async function WalletBsv21TokenPage({
	params,
}: Bsv21TokenPageProps) {
	const { tokenId } = await params;
	if (!isBsv21TokenId(tokenId)) notFound();
	return <Bsv21Detail tokenId={normalizeBsv21TokenId(tokenId)} />;
}
