"use client";

import type React from "react";
import { createContext, useContext, useState } from "react";
import type { Chain } from "@/lib/chain-endpoints";

interface CreateWalletContextType {
	mnemonic: string | null;
	setMnemonic: (mnemonic: string | null) => void;
	/** The new account's network, fixed once the wallet is created. */
	network: Chain;
	setNetwork: (network: Chain) => void;
}

const CreateWalletContext = createContext<CreateWalletContextType | undefined>(
	undefined,
);

export function CreateWalletProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	const [mnemonic, setMnemonic] = useState<string | null>(null);
	const [network, setNetwork] = useState<Chain>("main");

	return (
		<CreateWalletContext.Provider
			value={{ mnemonic, setMnemonic, network, setNetwork }}
		>
			{children}
		</CreateWalletContext.Provider>
	);
}

export function useCreateWallet() {
	const context = useContext(CreateWalletContext);
	if (!context) {
		throw new Error(
			"useCreateWallet must be used within a CreateWalletProvider",
		);
	}
	return context;
}
