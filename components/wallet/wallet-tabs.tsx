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
import {
	activeWalletTab,
	normalizeWalletPath,
	walletSubPageFor,
} from "@/lib/wallet-sections";
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
 * The wallet's sections, one link each, in a row that scrolls sideways when
 * it is wider than the screen. Phones show the names alone; from sm each name
 * has its icon. Every tab stays where it is and readable; the current one is
 * underlined. Sub-pages (settings, create) show a back arrow instead.
 */
export function WalletTabs() {
	const pathname = normalizeWalletPath(usePathname());
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

	// Centre the current tab in the row whenever the section changes. Only the
	// row scrolls, never the page.
	useEffect(() => {
		const list = listRef.current;
		if (hidden || !activeHref || !list) return;
		const current = list.querySelector<HTMLElement>('[aria-current="page"]');
		if (!current) return;
		const box = list.getBoundingClientRect();
		const tab = current.getBoundingClientRect();
		const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		list.scrollTo({
			left:
				list.scrollLeft +
				(tab.left - box.left) -
				(list.clientWidth - tab.width) / 2,
			behavior: still ? "instant" : "smooth",
		});
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
								{/* Names alone on phones; icon and name from sm. */}
								<Icon
									aria-hidden="true"
									className="size-4 shrink-0 max-sm:hidden"
								/>
								<span>{tab.label}</span>
							</Link>
						</li>
					);
				})}
			</ul>
		</nav>
	);
}
