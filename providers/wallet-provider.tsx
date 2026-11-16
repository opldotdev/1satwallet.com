"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { Chain } from "@/lib/chain-endpoints";
import { WALLET_STORAGE_KEY } from "@/lib/constants";
import { deriveIdentityKey, findKeysFromMnemonic } from "@/lib/keys";
import { reportDiagnostic } from "@/lib/runtime-diagnostics";
import type { Keys } from "@/lib/types";
import { refreshWalletChain } from "@/lib/wallet-chain";
import {
	clearCachedEncryptionKey,
	loadEncryptedWallet,
	saveEncryptedWallet,
	WalletSaveError,
	walletChangedElsewhere,
} from "@/lib/wallet-storage";

export { WalletSaveError };

interface WalletContextType {
	hasWallet: boolean;
	isWalletLocked: boolean;
	isWalletInitialized: boolean;
	walletKeys: Keys | null;
	/**
	 * False for a wrong password. Throws WalletSaveError, whose message is
	 * meant for the user, when the wallet's saved data could not be updated.
	 */
	unlockWallet: (passphrase: string) => Promise<boolean>;
	lockWallet: () => void;
	/** The network is fixed here, at creation, and never changes after. */
	createWallet: (
		mnemonic: string,
		passphrase: string,
		network: Chain,
	) => Promise<boolean>;
	importWallet: (
		keys: Keys,
		passphrase: string,
		network: Chain,
	) => Promise<boolean>;
	deleteWallet: () => void;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

export function WalletProvider({ children }: { children: ReactNode }) {
	const router = useRouter();
	const [hasWallet, setHasWallet] = useState(false);
	const [isWalletLocked, setIsWalletLocked] = useState(true);
	const [isWalletInitialized, setIsWalletInitialized] = useState(false);
	const [walletKeys, setWalletKeys] = useState<Keys | null>(null);
	const lifecycleGenerationRef = useRef(0);

	useEffect(() => {
		// The wallet replaced or removed in another tab (clear() there arrives
		// with a null key) or deleted here: lock and drop the keys, so the
		// built-in wallet never opens on one network with another account's
		// keys. This tab's own saves are skipped: they would clear the key
		// cache that the save just set.
		const handleStorageChange = (event: StorageEvent) => {
			const exists = walletChangedElsewhere(event, window.localStorage);
			if (exists !== undefined) {
				lifecycleGenerationRef.current += 1;
				setHasWallet(exists);
				setIsWalletLocked(exists);
				setWalletKeys(null);
				clearCachedEncryptionKey();
			}
		};
		window.addEventListener("storage", handleStorageChange);
		return () => window.removeEventListener("storage", handleStorageChange);
	}, []);

	// Load wallet on mount
	useEffect(() => {
		const encryptedWalletExists =
			typeof window !== "undefined" &&
			!!localStorage.getItem(WALLET_STORAGE_KEY);
		setHasWallet(encryptedWalletExists);

		if (!encryptedWalletExists) {
			clearCachedEncryptionKey();
			setWalletKeys(null);
			setIsWalletLocked(false);
		} else {
			setIsWalletLocked(true);
		}
		setIsWalletInitialized(true);
	}, []);

	const unlockWallet = useCallback(
		async (passphrase: string): Promise<boolean> => {
			const generation = ++lifecycleGenerationRef.current;
			try {
				const keys = await loadEncryptedWallet(passphrase);
				if (keys && generation === lifecycleGenerationRef.current) {
					setWalletKeys(keys);
					setIsWalletLocked(false);
					return true;
				}
			} catch (error) {
				reportDiagnostic({
					category: "action",
					code: "action.failed",
					operation: "wallet.unlock",
					recoverable: true,
					context: { retryable: true },
				});
				if (error instanceof WalletSaveError) throw error;
			}
			return false;
		},
		[],
	);

	const lockWallet = useCallback(() => {
		lifecycleGenerationRef.current += 1;
		setWalletKeys(null);
		setIsWalletLocked(true);
		clearCachedEncryptionKey();
		router.push("/");
	}, [router]);

	const createWallet = useCallback(
		async (
			mnemonic: string,
			passphrase: string,
			network: Chain,
		): Promise<boolean> => {
			try {
				const keys = await findKeysFromMnemonic(mnemonic);
				const identityKey = deriveIdentityKey(keys.payPk, keys.ordPk);
				keys.identityPk = identityKey.toWif();
				keys.identityAddressPath = "derived";
				const success = await saveEncryptedWallet(keys, passphrase, network);
				if (success) {
					setWalletKeys(keys);
					setHasWallet(true);
					setIsWalletLocked(false);

					router.push("/wallet");
					return true;
				}
			} catch {
				reportDiagnostic({
					category: "action",
					code: "action.failed",
					operation: "wallet.create",
					recoverable: true,
					context: { retryable: true },
				});
			}
			return false;
		},
		[router],
	);

	const importWallet = useCallback(
		async (
			keys: Keys,
			passphrase: string,
			network: Chain,
		): Promise<boolean> => {
			try {
				const importedKeys = { ...keys };
				if (
					!importedKeys.identityPk &&
					importedKeys.payPk &&
					importedKeys.ordPk
				) {
					const identityKey = deriveIdentityKey(
						importedKeys.payPk,
						importedKeys.ordPk,
					);
					importedKeys.identityPk = identityKey.toWif();
					importedKeys.identityAddressPath = "derived";
				}
				const success = await saveEncryptedWallet(
					importedKeys,
					passphrase,
					network,
				);
				if (success) {
					setWalletKeys(importedKeys);
					setHasWallet(true);
					setIsWalletLocked(false);

					router.push("/wallet");
					return true;
				}
			} catch {
				reportDiagnostic({
					category: "action",
					code: "action.failed",
					operation: "wallet.import",
					recoverable: true,
					context: { retryable: true },
				});
			}
			return false;
		},
		[router],
	);

	const deleteWallet = useCallback(() => {
		lifecycleGenerationRef.current += 1;
		if (typeof window !== "undefined") {
			localStorage.removeItem(WALLET_STORAGE_KEY);
			// Tells other listeners in this tab. A browser that refuses a
			// constructed StorageEvent must not skip the refresh and reset below.
			try {
				window.dispatchEvent(
					new StorageEvent("storage", {
						key: WALLET_STORAGE_KEY,
						newValue: null,
					}),
				);
			} catch {
				reportDiagnostic({
					category: "action",
					code: "action.failed",
					operation: "wallet.delete.notify",
					recoverable: true,
				});
			}
		}
		// Moves the chain when the event above did not; a no-op when it did.
		refreshWalletChain();
		clearCachedEncryptionKey();
		setWalletKeys(null);
		setHasWallet(false);
		setIsWalletLocked(false);
	}, []);

	const value = useMemo(
		() => ({
			hasWallet,
			isWalletLocked,
			isWalletInitialized,
			walletKeys,
			unlockWallet,
			lockWallet,
			createWallet,
			importWallet,
			deleteWallet,
		}),
		[
			hasWallet,
			isWalletLocked,
			isWalletInitialized,
			walletKeys,
			unlockWallet,
			lockWallet,
			createWallet,
			importWallet,
			deleteWallet,
		],
	);

	return (
		<WalletContext.Provider value={value}>{children}</WalletContext.Provider>
	);
}

export function useWallet() {
	const context = useContext(WalletContext);
	if (context === undefined) {
		throw new Error("useWallet must be used within a WalletProvider");
	}
	return context;
}
