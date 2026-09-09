"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import { Component, type ReactNode, useState } from "react";
import styles from "./download.module.css";

const PhoneScene = dynamic(() => import("./phone-scene"), { ssr: false });

export class PreviewBoundary extends Component<
	{ children: ReactNode; onError: () => void },
	{ failed: boolean }
> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	componentDidCatch() {
		this.props.onError();
	}
	render() {
		return this.state.failed ? null : this.props.children;
	}
}

export function PhonePreview() {
	const [ready, setReady] = useState(false);
	return (
		<>
			<Image
				className={styles.phoneFallback}
				style={{ visibility: ready ? "hidden" : "visible" }}
				src="/download/iphone-launch.png"
				alt=""
				width={1179}
				height={2556}
				sizes="280px"
				preload
			/>
			<div className={styles.phoneCanvas} aria-hidden="true">
				<PreviewBoundary onError={() => setReady(false)}>
					<PhoneScene onReady={() => setReady(true)} />
				</PreviewBoundary>
			</div>
		</>
	);
}
