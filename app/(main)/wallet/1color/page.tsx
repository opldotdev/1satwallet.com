import { OneColorDeploy } from "@/components/wallet/one-color-deploy";
import OneColorGrid from "@/components/wallet/one-color-grid";

export default function WalletOneColorPage() {
	return (
		<div className="space-y-6">
			<OneColorGrid />
			<OneColorDeploy />
		</div>
	);
}
