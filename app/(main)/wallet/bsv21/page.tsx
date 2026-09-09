import { Bsv21Deploy } from "@/components/wallet/bsv21-deploy";
import TokenGrid from "@/components/wallet/token-grid";

export default function WalletBsv21Page() {
	return (
		<div className="space-y-6">
			<TokenGrid />
			<Bsv21Deploy />
		</div>
	);
}
