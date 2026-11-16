"use client";

import {
	AtSign,
	CircleDollarSign,
	Fingerprint,
	Gem,
	History,
	type LucideIcon,
	ShieldCheck,
	Wallet,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSound } from "@/hooks/use-sound";
import { type WalletTabValue, walletTabsFor } from "@/lib/chain-surfaces";
import { useWalletChain } from "@/lib/hooks/use-wallet-chain";
import styles from "./wallet-tabs.module.css";

const icons: Record<WalletTabValue, LucideIcon> = {
	overview: Wallet,
	ordinals: Gem,
	opns: AtSign,
	identity: Fingerprint,
	certificates: ShieldCheck,
	bsv21: CircleDollarSign,
	history: History,
};

export function WalletTabs() {
	const router = useRouter();
	const pathname = usePathname();
	const { play } = useSound();
	const tabs = walletTabsFor(useWalletChain());

	const sortedTabs = [...tabs].sort((a, b) => b.href.length - a.href.length);

	// Determine the active tab based on the current pathname
	const activeTab =
		sortedTabs.find((tab) => pathname.startsWith(tab.href))?.value ||
		"overview";

	return (
		<Tabs
			defaultValue={activeTab}
			value={activeTab}
			onValueChange={(value) => {
				const tab = tabs.find((t) => t.value === value);
				if (tab) {
					play("click");
					router.push(tab.href);
				}
			}}
			className="w-full"
		>
			<TabsList className={styles.list}>
				{tabs.map((tab) => {
					const Icon = icons[tab.value];
					return (
						<TabsTrigger
							key={tab.value}
							value={tab.value}
							className={styles.trigger}
							title={tab.label}
							aria-label={tab.label}
						>
							<Icon className="h-4 w-4 shrink-0" />
							{/* icon-only on mobile so the tab row fits the viewport */}
							<span className="hidden sm:inline">{tab.label}</span>
						</TabsTrigger>
					);
				})}
			</TabsList>
		</Tabs>
	);
}
