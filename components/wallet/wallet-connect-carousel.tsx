"use client";

import {
	ArrowLeft,
	ArrowRight,
	Laptop,
	Loader2,
	type LucideIcon,
	Puzzle,
	RefreshCw,
	Smartphone,
	Wallet,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	LocalWalletBlockedHelp,
	LocalWalletPrimer,
	LocalWalletWaiting,
} from "@/components/wallet/local-wallet-access";
import { useWalletDiscovery } from "@/hooks/use-wallet-discovery";
import {
	type AdapterCoverage,
	coverageFor,
} from "@/lib/wallet/discovery/discovery";
import { type Slide, walletSlides } from "@/lib/wallet/discovery/slides";
import {
	isWalletAppBrowser,
	markHostWalletConnectTried,
	shouldConnectHostWallet,
} from "@/lib/wallet/host-wallet";
import {
	hasStoredWallet,
	WALLET_CONNECTION_MODE_KEY,
} from "@/lib/wallet-chain";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import styles from "./wallet-connect-carousel.module.css";

function savedConnectionMode(): string | null {
	try {
		return window.localStorage.getItem(WALLET_CONNECTION_MODE_KEY);
	} catch (error) {
		console.warn(
			"[wallet-connect] could not read the saved connection; not connecting the wallet app on its own",
			error instanceof Error ? error.message : String(error),
		);
		return "unreadable";
	}
}

type LocalPanel = "primer" | "help" | null;

function localStatus(
	coverage: AdapterCoverage | undefined,
	scanning: boolean,
	appName: string,
): string {
	if (!coverage || (scanning && coverage.state !== "blocked")) {
		return "Checking this computer…";
	}
	switch (coverage.cause) {
		case "permission-required":
			return "Not checked yet";
		case "permission-declined":
			return "Your browser's question closed without an answer. Nothing was shared.";
		case "permission-denied":
			return "Blocked by your browser";
		case "timeout":
		case "no-response":
			return `${appName} didn't answer`;
		default:
			return "Not running on this computer";
	}
}

export function WalletConnectCarousel() {
	const { isInitializing, initError, connectExternalWallet } =
		useWalletToolbox();
	const discovery = useWalletDiscovery();
	const { platform, snapshot, phase } = discovery;
	const [walletApp, setWalletApp] = useState(false);
	const [host, setHost] = useState("");
	const [activeKey, setActiveKey] = useState<string | null>(null);
	const [localPanel, setLocalPanel] = useState<LocalPanel>(null);
	const [helpHidden, setHelpHidden] = useState(false);
	const [lookError, setLookError] = useState<string | null>(null);
	const start = useRef<number | null>(null);
	const connectRef = useRef(connectExternalWallet);
	connectRef.current = connectExternalWallet;
	const initializingRef = useRef(isInitializing);
	initializingRef.current = isInitializing;

	useEffect(() => {
		setWalletApp(isWalletAppBrowser());
		setHost(window.location.host);
	}, []);

	const slides = walletSlides(platform, snapshot?.candidates ?? []);
	// Until the user moves, the first slide leads: whatever the scan found.
	const activeIndex = Math.max(
		0,
		slides.findIndex(({ key }) => key === activeKey),
	);
	const show = (index: number) =>
		setActiveKey(slides[(index + slides.length) % slides.length]?.key ?? null);
	const move = (step: number) => show(activeIndex + step);

	// Opened in a wallet app's browser (Metanet / bsv-browser) whose wallet
	// answered: connect it, as other BRC-100 apps do there. Once per tab
	// session, so a disconnect or a declined prompt leaves this picker in place.
	const foundInjected = !!snapshot?.candidates.some(
		({ option }) => option === "injected",
	);
	useEffect(() => {
		if (
			foundInjected &&
			isWalletAppBrowser() &&
			!initializingRef.current &&
			shouldConnectHostWallet({
				savedConnectionMode: savedConnectionMode(),
				hasStoredWallet: hasStoredWallet(),
			})
		) {
			markHostWalletConnectTried();
			void connectRef.current("injected");
		}
	}, [foundInjected]);

	const local = coverageFor(snapshot, "loopback");
	const waiting = phase === "waiting";
	const busy = isInitializing || waiting;

	const lookForLocalWallet = async () => {
		setLocalPanel(null);
		setLookError(null);
		try {
			const result = await discovery.elicit();
			if (!result) return;
			if (result.outcome === "denied") {
				setHelpHidden(false);
				return;
			}
			// BRC-325 section 6.3: back to what the user was doing, which was
			// connecting.
			const found = result.snapshot.candidates.find(
				({ adapter }) => adapter === "loopback",
			);
			if (found) {
				setActiveKey(`${found.adapter}:${found.option}`);
				void connectExternalWallet(found.option);
			}
		} catch (error) {
			setLookError(
				error instanceof Error
					? `Couldn't look for a wallet on this computer: ${error.message}`
					: "Couldn't look for a wallet on this computer.",
			);
		}
	};

	const slideView = (
		slide: Slide,
	): {
		name: string;
		icon: LucideIcon;
		description: string;
		body: React.ReactNode;
	} => {
		if (slide.kind === "candidate") {
			const { candidate } = slide;
			const inApp = candidate.adapter === "window.CWI" && walletApp;
			return {
				name: candidate.name,
				icon:
					candidate.adapter === "loopback"
						? Laptop
						: inApp
							? Smartphone
							: Puzzle,
				description: inApp
					? "This page is open in your wallet app. Connect it to use it here."
					: candidate.adapter === "loopback"
						? "Found running on this computer."
						: "Found in this browser.",
				body: (
					<>
						<Status ok text="Ready to connect" />
						<div className={styles.actions}>
							<Button
								disabled={busy}
								variant="secondary"
								onClick={() => void connectExternalWallet(candidate.option)}
							>
								{isInitializing && (
									<Loader2 className="motion-safe:animate-spin" />
								)}{" "}
								{isInitializing ? "Connecting…" : "Connect"}
							</Button>
						</div>
						<p className={styles.hint}>
							Approve the connection in your wallet.
						</p>
					</>
				),
			};
		}
		if (slide.kind === "local") {
			const mac = platform === "mac";
			const appName = mac ? "1Sat Wallet for Mac" : "Your desktop wallet";
			const name = mac ? "1Sat Wallet for Mac" : "Desktop wallet";
			const description = mac
				? "Connect the 1Sat Wallet app on this Mac."
				: "Connect a wallet app running on this computer.";
			if (waiting) {
				return {
					name,
					icon: Laptop,
					description: "",
					body: (
						<LocalWalletWaiting
							className={styles.panel}
							onStop={discovery.stopWaiting}
						/>
					),
				};
			}
			if (localPanel === "primer") {
				return {
					name,
					icon: Laptop,
					description: "",
					body: (
						<LocalWalletPrimer
							className={styles.panel}
							host={host}
							onLook={() => void lookForLocalWallet()}
							onSkip={() => setLocalPanel(null)}
						/>
					),
				};
			}
			const needsAsk =
				local?.cause === "permission-required" ||
				local?.cause === "permission-declined";
			const denied = local?.cause === "permission-denied";
			return {
				name,
				icon: Laptop,
				description: denied && !helpHidden ? "" : description,
				body: (
					<>
						<Status
							ok={false}
							text={localStatus(local, phase === "scanning", appName)}
						/>
						{denied && !helpHidden ? (
							<LocalWalletBlockedHelp
								className={styles.panel}
								onHide={() => setHelpHidden(true)}
							/>
						) : (
							<div className={styles.actions}>
								{needsAsk ? (
									<Button
										variant="secondary"
										disabled={busy}
										onClick={() => setLocalPanel("primer")}
									>
										Look for it
									</Button>
								) : (
									<Button
										variant="secondary"
										disabled={busy || phase === "scanning" || denied}
										onClick={discovery.refresh}
									>
										<RefreshCw
											className={
												phase === "scanning" ? "motion-safe:animate-spin" : ""
											}
										/>
										Check again
									</Button>
								)}
								{mac && (
									<Button asChild variant="ghost">
										<Link href="/download">Get the app</Link>
									</Button>
								)}
							</div>
						)}
						{!needsAsk && !denied && (
							<p className={styles.hint}>
								{mac
									? "Open 1Sat Wallet on this Mac, then check again."
									: "Open your desktop wallet, then check again."}
							</p>
						)}
						{lookError && (
							<p className="text-destructive text-sm" role="alert">
								{lookError}
							</p>
						)}
					</>
				),
			};
		}
		if (slide.kind === "phone-app") {
			return {
				name: "1Sat Wallet for iPhone",
				icon: Smartphone,
				description: "Keep your wallet in the 1Sat Wallet app on your iPhone.",
				body: (
					<>
						<Status ok text="Beta on TestFlight" />
						<div className={styles.actions}>
							<Button asChild variant="secondary">
								<Link href="/download">Get the app</Link>
							</Button>
						</div>
						<p className={styles.hint}>
							Already installed? Open it from your home screen.
						</p>
					</>
				),
			};
		}
		return {
			name: "Wallet in this browser",
			icon: Wallet,
			description: "Create a new wallet or bring one you already own.",
			body: (
				<>
					<Status ok text="Ready here" />
					<div className={styles.actions}>
						<Button asChild variant="secondary">
							<Link href="/wallet/create">Create wallet</Link>
						</Button>
						<Button asChild variant="ghost">
							<Link href="/wallet/import">Import wallet</Link>
						</Button>
					</div>
					<p className={styles.hint}>Encrypted and stored on this device.</p>
				</>
			),
		};
	};

	const views = slides.map((slide) => ({ slide, ...slideView(slide) }));

	return (
		<section
			className={styles.carousel}
			aria-roledescription="carousel"
			aria-label="Choose a wallet"
		>
			<div
				className={styles.stage}
				onTouchStart={(event) => {
					start.current = event.touches[0]?.clientX ?? null;
				}}
				onTouchEnd={(event) => {
					const end = event.changedTouches[0]?.clientX;
					if (
						!busy &&
						start.current !== null &&
						end !== undefined &&
						Math.abs(end - start.current) > 60
					)
						move(end < start.current ? 1 : -1);
					start.current = null;
				}}
			>
				{views.map(({ slide, name, icon: Icon, description, body }, index) => {
					const offset =
						index === activeIndex
							? 0
							: (index - activeIndex + slides.length) % slides.length === 1
								? 1
								: -1;
					return (
						<section
							key={slide.key}
							className={styles.slide}
							data-position={offset}
							aria-roledescription="slide"
							aria-label={`${name}, ${index + 1} of ${slides.length}`}
						>
							<div
								className={styles.slideContent}
								inert={offset !== 0}
								aria-hidden={offset !== 0}
							>
								<Icon
									className={styles.icon}
									strokeWidth={1}
									aria-hidden="true"
								/>
								<h2>{name}</h2>
								{description && (
									<p className={styles.description}>{description}</p>
								)}
								{body}
							</div>
							{offset !== 0 && (
								<button
									className={styles.selectSide}
									type="button"
									aria-label={`Show ${name}`}
									disabled={busy}
									onClick={() => show(index)}
								/>
							)}
						</section>
					);
				})}
			</div>
			{slides.length > 1 && (
				<div className={styles.controls}>
					<Button
						variant="ghost"
						size="icon"
						aria-label="Previous wallet option"
						disabled={busy}
						onClick={() => move(-1)}
					>
						<ArrowLeft />
					</Button>
					<div className={styles.picker}>
						{views.map(({ slide, name, icon: Icon }, index) => (
							<Button
								key={slide.key}
								variant="ghost"
								size="sm"
								aria-label={name}
								aria-pressed={activeIndex === index}
								disabled={busy}
								onClick={() => show(index)}
							>
								<Icon />
								<span>{name}</span>
							</Button>
						))}
					</div>
					<Button
						variant="ghost"
						size="icon"
						aria-label="Next wallet option"
						disabled={busy}
						onClick={() => move(1)}
					>
						<ArrowRight />
					</Button>
				</div>
			)}
			<div className="min-h-12 pt-4 text-center text-sm" aria-live="polite">
				{initError && (
					<p className="text-destructive" role="alert">
						{initError}
					</p>
				)}
			</div>
		</section>
	);
}

function Status({ ok, text }: { ok: boolean; text: string }) {
	return (
		<p className={styles.status} role="status">
			<span className={ok ? styles.available : styles.unavailable} />
			{text}
		</p>
	);
}
