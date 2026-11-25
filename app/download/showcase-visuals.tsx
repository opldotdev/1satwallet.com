import {
	ArrowDown,
	ArrowUp,
	ChevronRight,
	Cloud,
	QrCode,
	ScanFace,
	ScanLine,
	Smartphone,
} from "lucide-react";
import Image from "next/image";
import type { CSSProperties } from "react";
import styles from "./showcase.module.css";
import type { Shot, Vignette } from "./showcase-data";

export function DeviceShot({ shot }: { shot: Shot }) {
	return (
		<div className={styles.device}>
			<Image
				src={shot.src}
				width={shot.width}
				height={shot.height}
				alt={shot.alt}
				sizes="(max-width: 767px) 72vw, 380px"
			/>
		</div>
	);
}

export function Panel({ shot, float }: { shot: Shot; float?: boolean }) {
	return (
		<div className={float ? `${styles.panel} ${styles.float}` : styles.panel}>
			<Image
				src={shot.src}
				width={shot.width}
				height={shot.height}
				alt={shot.alt}
				sizes="(max-width: 767px) 90vw, 460px"
			/>
		</div>
	);
}

function Segmented({ items, selected }: { items: string[]; selected: number }) {
	return (
		<div className={styles.segmented}>
			{items.map((item, i) => (
				<span key={item} data-selected={i === selected}>
					{item}
				</span>
			))}
		</div>
	);
}

function PayVignette() {
	const buttons = [
		{ label: "Send", Icon: ArrowUp },
		{ label: "Receive", Icon: ArrowDown },
		{ label: "Scan", Icon: ScanLine },
	];
	return (
		<div
			className={styles.vignette}
			role="img"
			aria-label="Send, Receive and Scan buttons above a receive screen with Handle, Address and PeerPay tabs"
		>
			<div className={styles.roundButtons} aria-hidden="true">
				{buttons.map(({ label, Icon }) => (
					<span key={label}>
						<i>
							<Icon size={26} strokeWidth={2} />
						</i>
						{label}
					</span>
				))}
			</div>
			<div className={styles.card} aria-hidden="true">
				<Segmented items={["Handle", "Address", "PeerPay"]} selected={0} />
				<div className={styles.qrTile}>
					<QrCode size={112} strokeWidth={1.4} />
				</div>
			</div>
		</div>
	);
}

function MarketVignette() {
	const rows = ["Buy Listing", "Manage Listings", "Locked BSV"];
	return (
		<div
			className={styles.vignette}
			role="img"
			aria-label="Wallet rows for Buy Listing, Manage Listings and Locked BSV"
		>
			<div className={styles.list} aria-hidden="true">
				{rows.map((row) => (
					<span key={row}>
						{row}
						<ChevronRight className={styles.chevron} size={18} />
					</span>
				))}
			</div>
			<div className={styles.lockTrack} aria-hidden="true">
				<span>Now</span>
				<i />
				<span>Unlock height</span>
			</div>
		</div>
	);
}

function KeysVignette() {
	return (
		<div
			className={styles.vignette}
			role="img"
			aria-label="Face ID symbol above a Key Backup choice between iCloud and This iPhone"
		>
			<div className={styles.faceId} aria-hidden="true">
				<ScanFace size={72} strokeWidth={1.2} />
			</div>
			<div className={styles.card} aria-hidden="true">
				<p className={styles.cardTitle}>Key Backup</p>
				<div className={styles.custody}>
					<span className={styles.option} data-selected="true">
						<Cloud size={20} />
						iCloud Keychain
					</span>
					<span className={styles.option}>
						<Smartphone size={20} />
						This iPhone
					</span>
				</div>
			</div>
		</div>
	);
}

export function VignetteView({ kind }: { kind: Vignette }) {
	if (kind === "pay") return <PayVignette />;
	if (kind === "market") return <MarketVignette />;
	return <KeysVignette />;
}

export function Chips({ chips }: { chips: string[] }) {
	return (
		<ul className={styles.chips} aria-label="Pass kinds">
			{chips.map((chip) => (
				<li key={chip} data-color={chip === "1Color" || undefined}>
					{chip}
				</li>
			))}
		</ul>
	);
}

export function accentStyle(accent: string) {
	return { "--accent": accent } as CSSProperties;
}
