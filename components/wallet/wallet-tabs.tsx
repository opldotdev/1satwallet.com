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
import {
	centredScrollLeft,
	glideDuration,
	glidePosition,
	tabInView,
} from "@/lib/wallet-tab-scroll";
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

	// The glide to the current tab is ours, frame by frame, so a new section
	// always cancels the last one's: a browser smooth scroll left running could
	// land after the new section had already been centred.
	const glideRef = useRef<number | null>(null);
	// The row had no size when it should have been centred: centre it once
	// the ResizeObserver sees it get one.
	const pendingRef = useRef(false);

	const stopGlide = useCallback(() => {
		if (glideRef.current === null) return;
		cancelAnimationFrame(glideRef.current);
		glideRef.current = null;
	}, []);

	// Centre the current tab in the row. Only the row scrolls, never the page;
	// instantly under reduced motion, otherwise in a short glide that gives way
	// to anyone else who scrolls the row (a finger, a wheel, a focus).
	const centreCurrent = useCallback(() => {
		const list = listRef.current;
		if (!list) return;
		stopGlide();
		const current = list.querySelector<HTMLElement>('[aria-current="page"]');
		if (!current) {
			pendingRef.current = false;
			return;
		}
		const rowOf = () => {
			const box = list.getBoundingClientRect();
			return {
				box,
				row: {
					left: box.left,
					scrollLeft: list.scrollLeft,
					clientWidth: list.clientWidth,
					scrollWidth: list.scrollWidth,
				},
			};
		};
		const { box, row } = rowOf();
		const tab = current.getBoundingClientRect();
		if (box.width === 0 || tab.width === 0) {
			pendingRef.current = true;
			return;
		}
		pendingRef.current = false;
		const from = row.scrollLeft;
		const target = centredScrollLeft(row, tab);
		const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		if (still || Math.abs(target - from) < 1) {
			list.scrollTo({ left: target, behavior: "instant" });
			measure();
			return;
		}
		const duration = glideDuration(target - from);
		let start: number | null = null;
		let written = from;
		const step = (now: number) => {
			glideRef.current = null;
			// Someone else moved the row since our last frame: leave it to them.
			if (Math.abs(list.scrollLeft - written) > 1) return;
			start ??= now;
			const elapsed = now - start;
			list.scrollTo({
				left: glidePosition(from, target, elapsed, duration),
				behavior: "instant",
			});
			written = list.scrollLeft;
			if (elapsed < duration) {
				glideRef.current = requestAnimationFrame(step);
				return;
			}
			// Landed. If the layout moved under the glide, put the tab in view now.
			const { box, row } = rowOf();
			const tab = current.getBoundingClientRect();
			if (current.isConnected && !tabInView(tab, box)) {
				list.scrollTo({
					left: centredScrollLeft(row, tab),
					behavior: "instant",
				});
			}
			measure();
		};
		glideRef.current = requestAnimationFrame(step);
	}, [measure, stopGlide]);

	useEffect(() => {
		const list = listRef.current;
		if (hidden || !list) return;
		const observer = new ResizeObserver(() => {
			measure();
			if (pendingRef.current) centreCurrent();
		});
		observer.observe(list);
		return () => observer.disconnect();
	}, [hidden, measure, centreCurrent]);

	// Centre the current tab whenever the section changes.
	useEffect(() => {
		if (hidden || !activeHref) return;
		centreCurrent();
		return stopGlide;
	}, [hidden, activeHref, centreCurrent, stopGlide]);

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
