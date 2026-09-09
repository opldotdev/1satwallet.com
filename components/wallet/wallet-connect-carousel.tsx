"use client";

import {
	ArrowLeft,
	ArrowRight,
	Laptop,
	Loader2,
	Puzzle,
	RefreshCw,
	Smartphone,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	isConnectionAvailable,
	type WalletConnectionOption,
} from "@/lib/wallet/connection-options";
import { useWalletToolbox } from "@/providers/wallet-toolbox-provider";
import styles from "./wallet-connect-carousel.module.css";

const options = [
	{
		id: "embedded",
		name: "Embedded mobile",
		icon: Smartphone,
		description:
			"Your wallet, right here. Create a new wallet or bring one you already own.",
		hint: "Encrypted and stored on this device.",
	},
	{
		id: "injected",
		name: "Injected wallet",
		icon: Puzzle,
		description: "Connect a wallet extension in your browser.",
		hint: "Enable your wallet extension, then check again.",
	},
	{
		id: "desktop",
		name: "Desktop Wallet",
		icon: Laptop,
		description: "Connect to the wallet running on your computer.",
		hint: "Open your desktop wallet, then check again.",
	},
] as const;
type Availability = Record<WalletConnectionOption, boolean | null>;

export function WalletConnectCarousel() {
	const { isInitializing, initError, connectExternalWallet } =
		useWalletToolbox();
	const [active, setActive] = useState(0);
	const [availability, setAvailability] = useState<Availability>({
		embedded: null,
		injected: null,
		desktop: null,
	});
	const [checking, setChecking] = useState(true);
	const mounted = useRef(false);
	const checkingRef = useRef(false);
	const start = useRef<number | null>(null);
	const move = (step: number) =>
		setActive((value) => (value + step + options.length) % options.length);
	const check = useCallback(async () => {
		if (checkingRef.current) return;
		checkingRef.current = true;
		setChecking(true);
		try {
			const results = await Promise.all(
				options.map(
					async ({ id }) => [id, await isConnectionAvailable(id)] as const,
				),
			);
			if (mounted.current)
				setAvailability(Object.fromEntries(results) as Availability);
		} finally {
			checkingRef.current = false;
			if (mounted.current) setChecking(false);
		}
	}, []);
	useEffect(() => {
		mounted.current = true;
		void check();
		window.addEventListener("focus", check);
		return () => {
			mounted.current = false;
			window.removeEventListener("focus", check);
		};
	}, [check]);

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
						!isInitializing &&
						start.current !== null &&
						end !== undefined &&
						Math.abs(end - start.current) > 60
					)
						move(end < start.current ? 1 : -1);
					start.current = null;
				}}
			>
				{options.map(({ id, name, icon: Icon, description, hint }, index) => {
					const offset =
						index === active
							? 0
							: (index - active + options.length) % options.length === 1
								? 1
								: -1;
					const available = availability[id];
					return (
						<section
							key={id}
							className={styles.slide}
							data-position={offset}
							aria-roledescription="slide"
							aria-label={`${name}, ${index + 1} of 3`}
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
								<p className={styles.description}>{description}</p>
								<p className={styles.status} role="status">
									<span
										className={
											available || id === "embedded"
												? styles.available
												: styles.unavailable
										}
									/>
									{id === "embedded"
										? available
											? "Mobile wallet available"
											: "Built-in wallet available"
										: checking
											? "Checking availability…"
											: available
												? "Available to connect"
												: "Not detected"}
								</p>
								<div className={styles.actions}>
									{id === "embedded" ? (
										<>
											<Button asChild variant="secondary">
												<Link href="/wallet/create">Create wallet</Link>
											</Button>
											<Button asChild variant="ghost">
												<Link href="/wallet/import">Import wallet</Link>
											</Button>
										</>
									) : (
										<Button
											disabled={!available || isInitializing}
											variant="secondary"
											onClick={() => void connectExternalWallet(id)}
										>
											{isInitializing && (
												<Loader2 className="motion-safe:animate-spin" />
											)}{" "}
											{isInitializing ? "Connecting…" : "Connect"}
										</Button>
									)}
								</div>
								<p className={styles.hint}>
									{id === "embedded"
										? hint
										: available
											? "Approve the connection in your wallet."
											: hint}
								</p>
								{id !== "embedded" && (
									<Button
										variant="ghost"
										size="sm"
										disabled={checking || isInitializing}
										onClick={() => void check()}
									>
										<RefreshCw
											className={checking ? "motion-safe:animate-spin" : ""}
										/>
										Check again
									</Button>
								)}
							</div>
							{offset !== 0 && (
								<button
									className={styles.selectSide}
									type="button"
									aria-label={`Show ${name}`}
									disabled={isInitializing}
									onClick={() => setActive(index)}
								/>
							)}
						</section>
					);
				})}
			</div>
			<div className={styles.controls}>
				<Button
					variant="ghost"
					size="icon"
					aria-label="Previous wallet option"
					disabled={isInitializing}
					onClick={() => move(-1)}
				>
					<ArrowLeft />
				</Button>
				<div className={styles.picker}>
					{options.map(({ id, name, icon: Icon }, index) => (
						<Button
							key={id}
							variant="ghost"
							size="sm"
							aria-label={name}
							aria-pressed={active === index}
							disabled={isInitializing}
							onClick={() => setActive(index)}
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
					disabled={isInitializing}
					onClick={() => move(1)}
				>
					<ArrowRight />
				</Button>
			</div>
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
