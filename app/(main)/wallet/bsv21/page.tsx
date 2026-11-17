import { redirect } from "next/navigation";

/** BSV-21 tokens are in the Tokens section now. */
export default function WalletBsv21Page() {
	redirect("/wallet/tokens");
}
