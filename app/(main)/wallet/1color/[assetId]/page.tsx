import type { Metadata } from "next";
import { notFound } from "next/navigation";
import OneColorDetail from "@/components/wallet/one-color-detail";
import { isOneColorAvailable } from "@/lib/chain-endpoints";
import { stackServicesFor } from "@/lib/stack";
import { isColorAssetId } from "@/lib/wallet/color-overlay";
import { getOneColorAssetInfo, oneColorTicker } from "@/lib/wallet/one-color";

interface OneColorTokenPageProps {
	params: Promise<{ assetId: string }>;
}

export default async function WalletOneColorTokenPage({
	params,
}: OneColorTokenPageProps) {
	const { assetId } = await params;
	if (!isColorAssetId(assetId)) notFound();
	return <OneColorDetail assetId={assetId} />;
}

/** 1Color runs on testnet only, so the title is read from the testnet deploy. */
export async function generateMetadata({
	params,
}: OneColorTokenPageProps): Promise<Metadata> {
	const { assetId } = await params;
	const fallback = { title: "1Color token - 1Sat" };
	if (!isColorAssetId(assetId) || !isOneColorAvailable("test")) return fallback;
	try {
		const info = await getOneColorAssetInfo(
			{ chain: "test", services: stackServicesFor("test") },
			assetId,
		);
		return {
			title: `${oneColorTicker({ sym: info.sym, assetId })} 1Color - 1Sat`,
			description: `Balances, overlay and history of the 1Color token ${assetId}.`,
		};
	} catch (error) {
		console.error(`[1color] metadata for ${assetId} not read:`, error);
		return fallback;
	}
}
