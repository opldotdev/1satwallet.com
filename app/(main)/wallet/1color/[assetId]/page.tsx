import { notFound } from "next/navigation";
import OneColorDetail from "@/components/wallet/one-color-detail";
import { isColorAssetId } from "@/lib/wallet/color-overlay";

export default async function WalletOneColorTokenPage({
	params,
}: {
	params: Promise<{ assetId: string }>;
}) {
	const { assetId } = await params;
	if (!isColorAssetId(assetId)) notFound();
	return <OneColorDetail assetId={assetId} />;
}
