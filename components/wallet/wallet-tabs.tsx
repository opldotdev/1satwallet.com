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
import { glideFrame, planCentre, type RowView } from "@/lib/wallet-tab-scroll";
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

/** The tab row as it stands now, for the glide's decisions. */
function viewOf(list: HTMLUListElement): RowView {
	const box = list.getBoundingClientRect();
	const current = list.querySelector<HTMLElement>('[aria-current="page"]');
	return {
		row: {
			left: box.left,
			scrollLeft: list.scrollLeft,
			clientWidth: list.clientWidth,
			scrollWidth: list.scrollWidth,
		},
		box,
		tab: current?.getBoundingClientRect() ?? null,
		href: current?.getAttribute("href") ?? null,
	};
}

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
	// A finger, pointer, wheel or key went to the row since the glide began:
	// the glide yields to it. Any other scroll it did not write is the layout
	// moving, and the glide aims again instead.
	const userInputRef = useRef(false);
	// The row had no size when it should have been centred: centre it once
	// the ResizeObserver sees it get one.
	const pendingRef = useRef(false);

	const stopGlide = useCallback(() => {
		if (glideRef.current === null) return;
		cancelAnimationFrame(glideRef.current);
		glideRef.current = null;
	}, []);

	// Centre the current tab in the row. Only the row scrolls, never the page;
	// instantly under reduced motion, otherwise in a short glide. What each
	// frame does is decided by glideFrame (lib/wallet-tab-scroll.ts).
	const centreCurrent = useCallback(() => {
		const list = listRef.current;
		if (!list) return;
		stopGlide();
		userInputRef.current = false;
		const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		const plan = planCentre(viewOf(list), still);
		pendingRef.current = plan.type === "defer";
		if (plan.type === "none" || plan.type === "defer") return;
		if (plan.type === "jump") {
			list.scrollTo({ left: plan.left, behavior: "instant" });
			measure();
			return;
		}
		const { glide } = plan;
		let start: number | null = null;
		let written = glide.from;
		const step = (now: number) => {
			glideRef.current = null;
			start ??= now;
			const next = glideFrame(glide, viewOf(list), {
				elapsed: now - start,
				written,
				userInput: userInputRef.current,
			});
			switch (next.type) {
				case "stop":
				case "yield":
					return;
				case "defer":
					pendingRef.current = true;
					return;
				case "reaim":
					centreCurrent();
					return;
				case "step":
					list.scrollTo({ left: next.left, behavior: "instant" });
					written = list.scrollLeft;
					glideRef.current = requestAnimationFrame(step);
					return;
				case "land":
					list.scrollTo({ left: next.left, behavior: "instant" });
					measure();
					return;
			}
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
		// Someone is scrolling the row by hand: the glide's next frame yields.
		const onInput = () => {
			userInputRef.current = true;
		};
		const inputs = ["pointerdown", "touchstart", "wheel", "keydown"] as const;
		for (const type of inputs) {
			list.addEventListener(type, onInput, { passive: true });
		}
		return () => {
			observer.disconnect();
			for (const type of inputs) list.removeEventListener(type, onInput);
		};
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
