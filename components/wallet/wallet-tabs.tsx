"use client";

import {
	AtSign,
	CircleDollarSign,
	Fingerprint,
	Gem,
	History,
	type LucideIcon,
	Palette,
	ShieldCheck,
	Wallet,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSound } from "@/hooks/use-sound";
import { type WalletTabValue, walletTabsFor } from "@/lib/chain-surfaces";
import { useWalletChain } from "@/lib/hooks/use-wallet-chain";
import { cn } from "@/lib/utils";
import { activeWalletTab, walletSubPageFor } from "@/lib/wallet-sections";
import styles from "./wallet-tabs.module.css";

const icons: Record<WalletTabValue, LucideIcon> = {
	overview: Wallet,
	ordinals: Gem,
	opns: AtSign,
	identity: Fingerprint,
	certificates: ShieldCheck,
	bsv21: CircleDollarSign,
	"1color": Palette,
	history: History,
};

/**
 * The wallet's sections, one link each. On phones only the current one shows
 * its name beside its icon; from sm every tab is labelled. Sub-pages
 * (settings, create, a token's detail) show a back arrow instead.
 */
export function WalletTabs() {
	const pathname = usePathname();
	const { play } = useSound();
	const tabs = walletTabsFor(useWalletChain());
	const activeHref = activeWalletTab(pathname, tabs)?.href;
	const hidden = walletSubPageFor(pathname) !== null;
	const listRef = useRef<HTMLUListElement>(null);
	// More tabs past the right edge: fade that edge so it reads as scrollable.
	const [moreAfter, setMoreAfter] = useState(false);

	const measure = useCallback(() => {
		const list = listRef.current;
		if (!list) return;
		setMoreAfter(list.scrollLeft + list.clientWidth < list.scrollWidth - 1);
	}, []);

	useEffect(() => {
		const list = listRef.current;
		if (hidden || !list) return;
		const observer = new ResizeObserver(measure);
		observer.observe(list);
		return () => observer.disconnect();
	}, [hidden, measure]);

	// Bring the current tab into view whenever the section changes.
	useEffect(() => {
		if (hidden || !activeHref) return;
		const current = listRef.current?.querySelector<HTMLElement>(
			'[aria-current="page"]',
		);
		if (!current) return;
		const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		current.scrollIntoView({
			behavior: still ? "auto" : "smooth",
			block: "nearest",
			inline: "center",
		});
		// The current tab's label changes the row's width; a smooth scroll
		// measures again as it moves.
		measure();
	}, [hidden, activeHref, measure]);

	if (hidden) return null;

	return (
		<nav aria-label="Wallet sections">
			<ul
				ref={listRef}
				className={styles.list}
				data-more-after={moreAfter || undefined}
				onScroll={measure}
			>
				{tabs.map((tab) => {
					const Icon = icons[tab.value];
					const current = tab.href === activeHref;
					return (
						<li key={tab.value} className={styles.item}>
							<Link
								aria-current={current ? "page" : undefined}
								className={styles.link}
								href={tab.href}
								onClick={() => {
									if (!current) play("click");
								}}
							>
								<Icon aria-hidden="true" className="size-4 shrink-0" />
								{/* Phones name only the current tab; the others keep
								    their name for screen readers. */}
								<span className={cn(!current && "max-sm:sr-only")}>
									{tab.label}
								</span>
							</Link>
						</li>
					);
				})}
			</ul>
		</nav>
	);
}
