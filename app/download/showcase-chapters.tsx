import type { CSSProperties, ReactNode } from "react";
import styles from "./showcase.module.css";
import { type Chapter, chapters, coverShot } from "./showcase-data";
import {
	accentStyle,
	Chips,
	DeviceShot,
	Panel,
	VignetteView,
} from "./showcase-visuals";

function ChapterVisual({ chapter }: { chapter: Chapter }) {
	const main = chapter.shots.find((shot) => shot.place === "main");
	const floats = chapter.shots.filter((shot) => shot.place === "float");
	return (
		<div className={styles.visual} data-frame={main?.frame ?? "vignette"}>
			<div className={styles.glow} aria-hidden="true" />
			{main ? (
				main.frame === "device" ? (
					<DeviceShot shot={main} />
				) : (
					<Panel shot={main} />
				)
			) : chapter.vignette ? (
				<VignetteView kind={chapter.vignette} />
			) : null}
			{floats.map((shot) => (
				<Panel key={shot.src} shot={shot} float />
			))}
		</div>
	);
}

function ChapterSection({
	chapter,
	index,
}: {
	chapter: Chapter;
	index: number;
}) {
	const titleId = `showcase-${chapter.id}`;
	return (
		<section
			id={`feature-${chapter.id}`}
			className={styles.chapter}
			data-chapter={chapter.id}
			data-flip={index % 2 === 1 || undefined}
			aria-labelledby={titleId}
			style={accentStyle(chapter.accent)}
		>
			<ChapterVisual chapter={chapter} />
			<div className={styles.copy}>
				<p className={styles.eyebrow}>{chapter.eyebrow}</p>
				<h3 id={titleId}>{chapter.title}</h3>
				<p className={styles.body}>{chapter.body}</p>
				<ul className={styles.points}>
					{chapter.points.map((point, i) => (
						<li key={point} style={{ "--i": i } as CSSProperties}>
							{point}
						</li>
					))}
				</ul>
				{chapter.chips ? <Chips chips={chapter.chips} /> : null}
				{chapter.note ? (
					<p className={styles.note}>
						<span>{chapter.note.tag}</span>
						{chapter.note.text}
					</p>
				) : null}
			</div>
		</section>
	);
}

export function ShowcaseChapters({
	title,
	description,
	closing,
}: {
	title: ReactNode;
	description: ReactNode;
	closing: ReactNode;
}) {
	return (
		<>
			<header
				className={styles.cover}
				data-chapter="cover"
				style={accentStyle("#f0bb00")}
			>
				<div className={styles.coverCopy}>
					<p className={styles.eyebrow}>1Sat Wallet for iPhone, iPad and Mac</p>
					{title}
					{description}
				</div>
				<div className={styles.coverShot}>
					<div className={styles.glow} aria-hidden="true" />
					<DeviceShot shot={coverShot} preload />
				</div>
			</header>
			{chapters.map((chapter, index) => (
				<ChapterSection key={chapter.id} chapter={chapter} index={index} />
			))}
			<footer className={styles.closing} data-chapter="closing">
				{closing}
			</footer>
		</>
	);
}
