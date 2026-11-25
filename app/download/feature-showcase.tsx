"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { ArrowDownRight, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { TESTFLIGHT_URL } from "./links";
import styles from "./showcase.module.css";
import { ShowcaseChapters } from "./showcase-chapters";
import { chapters } from "./showcase-data";

const HASH = "#features";
const stops = ["cover", ...chapters.map((chapter) => chapter.id), "closing"];

export function FeatureShowcase() {
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState("cover");
	const scroller = useRef<HTMLDivElement>(null);

	// The dialog follows the #features hash so a link can open it and Back closes it.
	useEffect(() => {
		const sync = () => setOpen(window.location.hash === HASH);
		sync();
		window.addEventListener("popstate", sync);
		return () => window.removeEventListener("popstate", sync);
	}, []);

	const changeOpen = useCallback((next: boolean) => {
		if (next) {
			window.history.pushState({ showcase: true }, "", HASH);
			setOpen(true);
			return;
		}
		setOpen(false);
		if (window.history.state?.showcase) {
			window.history.back();
		} else if (window.location.hash === HASH) {
			const { pathname, search } = window.location;
			window.history.replaceState(null, "", pathname + search);
		}
	}, []);

	// Reveal chapters once as they enter, and track the one in view for the rail.
	// Runs from a ref callback because Radix mounts the content after open flips.
	const observe = useCallback((root: HTMLDivElement | null) => {
		scroller.current = root;
		if (!root) return;
		const sections = root.querySelectorAll<HTMLElement>("[data-chapter]");
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					const target = entry.target as HTMLElement;
					target.dataset.inview = "true";
					setActive(target.dataset.chapter ?? "cover");
				}
			},
			{ root, threshold: 0.35 },
		);
		for (const section of sections) observer.observe(section);
		return () => observer.disconnect();
	}, []);

	const jump = useCallback((id: string) => {
		const root = scroller.current;
		const target = root?.querySelector<HTMLElement>(`[data-chapter="${id}"]`);
		if (!root || !target) return;
		const reduce = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches;
		target.scrollIntoView({
			behavior: reduce ? "auto" : "smooth",
			block: "start",
		});
	}, []);

	const onKeyDown = (event: React.KeyboardEvent) => {
		const forward = event.key === "ArrowDown" || event.key === "j";
		const back = event.key === "ArrowUp" || event.key === "k";
		if (!forward && !back) return;
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		event.preventDefault();
		const index = stops.indexOf(active);
		const next =
			stops[
				Math.min(stops.length - 1, Math.max(0, index + (forward ? 1 : -1)))
			];
		jump(next);
	};

	return (
		<Dialog.Root open={open} onOpenChange={changeOpen}>
			<Dialog.Trigger className={styles.trigger}>
				See everything it does <ArrowDownRight size={14} aria-hidden="true" />
			</Dialog.Trigger>
			<Dialog.Portal>
				<Dialog.Content
					className={styles.showcase}
					onKeyDown={onKeyDown}
					onOpenAutoFocus={(event) => {
						event.preventDefault();
						scroller.current?.focus();
					}}
				>
					<div ref={observe} className={styles.scroller} tabIndex={-1}>
						<ShowcaseChapters
							title={
								<Dialog.Title className={styles.coverTitle}>
									One wallet.
									<br />
									Everything on it.
								</Dialog.Title>
							}
							description={
								<Dialog.Description className={styles.coverLine}>
									Bitcoin, ordinals, tokens, names and identity, on iPhone, iPad
									and Mac.
								</Dialog.Description>
							}
							closing={
								<>
									<h3>Try it.</h3>
									<p>The beta is open on TestFlight. Use a test wallet.</p>
									<div className={styles.closingActions}>
										<a className={styles.primary} href={TESTFLIGHT_URL}>
											Download beta
										</a>
										<Dialog.Close className={styles.back}>
											Back to download
										</Dialog.Close>
									</div>
								</>
							}
						/>
					</div>
					<div className={styles.progress} aria-hidden="true" />
					<nav className={styles.rail} aria-label="Feature chapters">
						{chapters.map((chapter) => (
							<button
								key={chapter.id}
								type="button"
								aria-label={chapter.eyebrow}
								aria-current={active === chapter.id || undefined}
								onClick={() => jump(chapter.id)}
								style={{ "--accent": chapter.accent } as React.CSSProperties}
							/>
						))}
					</nav>
					<Dialog.Close className={styles.close} aria-label="Close features">
						<X size={20} />
					</Dialog.Close>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
