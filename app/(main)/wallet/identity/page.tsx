"use client";
import { BapIdentityCenter } from "@/components/wallet/bap-identity-center";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
export default function WalletIdentityPage() {
	const { identityKey } = useWalletToolbox();
	return <BapIdentityCenter key={identityKey ?? "disconnected"} />;
}
