"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { ArrowUpRight, CircleAlert, X } from "lucide-react";
import styles from "./download.module.css";

export function BetaNotice() {
	return (
		<Dialog.Root>
			<Dialog.Trigger className={styles.notice}>
				Beta notice <ArrowUpRight size={14} aria-hidden="true" />
			</Dialog.Trigger>
			<Dialog.Portal>
				<Dialog.Overlay className={styles.overlay} />
				<Dialog.Content className={styles.dialog}>
					<Dialog.Close className={styles.close} aria-label="Close beta notice">
						<X size={19} />
					</Dialog.Close>
					<CircleAlert
						className={styles.warning}
						size={32}
						strokeWidth={1.5}
						aria-hidden="true"
					/>
					<Dialog.Title>Before you try the beta</Dialog.Title>
					<Dialog.Description>
						Use a test wallet. Bugs can cause permanent loss. Back up your keys.
					</Dialog.Description>
					<Dialog.Close className={styles.confirm}>Got it</Dialog.Close>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
