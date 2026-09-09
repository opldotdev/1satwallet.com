"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import styles from "./download.module.css";
import { PreviewBoundary } from "./phone-preview";

const MacScene = dynamic(() => import("./device-stage"), { ssr: false });

export function MacPreview() {
	const [ready, setReady] = useState(false);
	return (
		<div className={styles.macCanvas} data-ready={ready} aria-hidden="true">
			<PreviewBoundary onError={() => setReady(false)}>
				<MacScene onReady={() => setReady(true)} />
			</PreviewBoundary>
		</div>
	);
}
