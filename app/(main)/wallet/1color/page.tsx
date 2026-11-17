import { redirect } from "next/navigation";

/** 1Color tokens are in the Tokens section now (testnet only). */
export default function WalletOneColorPage() {
	redirect("/wallet/tokens");
}
