"use client";

import { PrivateKey } from "@bsv/sdk";
import { useCallback, useState } from "react";
import { deriveIdentityKey, type Keys } from "@/lib/keys";
import type {
	SweepAuditInit,
	SweepAuditRecord,
	SweepAuditSource,
} from "@/lib/sweep-audit/record";
import {
	SWEEP_AUDIT_SAVE_ERROR,
	type SweepAuditRun,
	startSweepAudit,
} from "@/lib/sweep-audit/recorder";
import {
	memorySweepAuditStore,
	sweepAuditStore,
} from "@/lib/sweep-audit/store";

/**
 * The public identity key a wallet's sweep records are kept under: its
 * identity key, or for a wallet not yet migrated the identity key the
 * migration gives it (deriveIdentityKey), so a run and its retry after the
 * upgrade share one history. Only the public key leaves this function.
 */
export function sweepAuditIdentityKey(
	keys: Pick<Keys, "identityPk" | "payPk" | "ordPk">,
): string | null {
	try {
		if (keys.identityPk) {
			return PrivateKey.fromWif(keys.identityPk).toPublicKey().toString();
		}
		if (keys.payPk && keys.ordPk) {
			return deriveIdentityKey(keys.payPk, keys.ordPk).toPublicKey().toString();
		}
	} catch (error) {
		console.error(
			"[sweep-audit] could not read the wallet identity key",
			error,
		);
	}
	return null;
}

/** The legacy migration's sources, from the addresses the scan reads. */
export function migrationAuditSources(addresses: {
	payAddress?: string | null;
	ordAddress?: string | null;
	identityAddress?: string | null;
}): SweepAuditSource[] {
	const sources: SweepAuditSource[] = [];
	if (addresses.payAddress) {
		sources.push({
			address: addresses.payAddress,
			label: "Legacy pay",
			scheme: "original 1Sat payPk (bare WIF, P2PKH)",
		});
	}
	if (addresses.ordAddress) {
		sources.push({
			address: addresses.ordAddress,
			label: "Legacy ord",
			scheme: "original 1Sat ordPk (bare WIF, P2PKH)",
		});
	}
	if (addresses.identityAddress) {
		sources.push({
			address: addresses.identityAddress,
			label: "Legacy identity",
			scheme: "identity key (bare WIF, P2PKH)",
		});
	}
	return sources;
}

/**
 * A sweep host's audit trail: begin() starts a run's record and saves it;
 * `record` is the latest run's record, `saveError` a short message when a
 * save failed (the failure itself is logged). Without the wallet's identity
 * key the record is kept on this page only, and saveError says so.
 */
export function useSweepAudit() {
	const [record, setRecord] = useState<SweepAuditRecord | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const begin = useCallback(
		(
			init: Omit<SweepAuditInit, "identityKey">,
			identityKey: string | null,
		): SweepAuditRun => {
			setSaveError(null);
			if (!identityKey) {
				console.error(
					"[sweep-audit] no wallet identity key; this run's record is kept on this page only",
				);
				setSaveError(SWEEP_AUDIT_SAVE_ERROR);
			}
			return startSweepAudit(
				{ ...init, identityKey: identityKey ?? "unknown" },
				{
					store: identityKey ? sweepAuditStore() : memorySweepAuditStore(),
					onChange: setRecord,
					onSaveError: (message) => setSaveError(message),
				},
			);
		},
		[],
	);
	/** Forget the last run on screen (a new scan starts); its record stays saved. */
	const clear = useCallback(() => {
		setRecord(null);
		setSaveError(null);
	}, []);
	return { record, saveError, begin, clear };
}
