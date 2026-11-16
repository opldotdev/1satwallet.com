"use client";

import { BapIdentityCenter } from "@/components/wallet/bap-identity-center";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";

/** A fresh identity form per wallet, so one account's edits never show in another's. */
export function IdentityCenter() {
	const { identityKey } = useWalletToolbox();
	return <BapIdentityCenter key={identityKey ?? "disconnected"} />;
}
