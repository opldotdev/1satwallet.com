"use client";

import type {
	CounterpartyPermissions,
	GroupedPermissions,
} from "@bsv/wallet-toolbox-client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	type BridgeAssetPermissionRequest,
	type BridgeCounterpartyPermissionRequest,
	type BridgeGroupedPermissionRequest,
	type BridgePermissionRequest,
	type BridgeTransportState,
	CWIBridge,
	type WalletStatus,
} from "@/lib/cwi/bridge";
import type { CWIIndividualGrant } from "@/lib/cwi/types";

interface CWIBridgeState {
	status: WalletStatus;
	activePermission: BridgePermissionRequest | null;
	activeGroupedPermission: BridgeGroupedPermissionRequest | null;
	activeCounterpartyPermission: BridgeCounterpartyPermissionRequest | null;
	activeAssetPermission: BridgeAssetPermissionRequest | null;
	queueLength: number;
	transport: "embed";
	fallbackRecommended: boolean;
	reason?: BridgeTransportState["reason"];
	storageAccessRequired: boolean;
	grantPermission: (requestID: string, grant?: CWIIndividualGrant) => void;
	denyPermission: (requestID: string) => void;
	grantGroupedPermission: (
		requestID: string,
		granted: Partial<GroupedPermissions>,
		expiry?: number,
	) => void;
	denyGroupedPermission: (requestID: string) => void;
	grantCounterpartyPermission: (
		requestID: string,
		granted: Partial<CounterpartyPermissions>,
		expiry?: number,
	) => void;
	denyCounterpartyPermission: (requestID: string) => void;
	respondToAssetPermission: (requestID: string, approved: boolean) => void;
	grantStorageAccess: () => void;
	retryStatus: () => void;
}

/**
 * React hook for the CWI iframe bridge.
 *
 * No wallet dependency — self-contained. Communicates with the wallet tab
 * via BroadcastChannel through the CWIBridge class.
 */
export function useCWIBridge(): CWIBridgeState {
	const bridgeRef = useRef<CWIBridge | null>(null);
	const [status, setStatus] = useState<WalletStatus>("checking");
	const [transportState, setTransportState] = useState<BridgeTransportState>({
		transport: "embed",
		fallbackRecommended: false,
	});
	const [permissionQueue, setPermissionQueue] = useState<
		BridgePermissionRequest[]
	>([]);
	const [groupedQueue, setGroupedQueue] = useState<
		BridgeGroupedPermissionRequest[]
	>([]);
	const [counterpartyQueue, setCounterpartyQueue] = useState<
		BridgeCounterpartyPermissionRequest[]
	>([]);
	const [assetPermissionQueue, setAssetPermissionQueue] = useState<
		BridgeAssetPermissionRequest[]
	>([]);
	const [storageAccessRequired, setStorageAccessRequired] = useState(false);

	const activePermission = permissionQueue[0] ?? null;
	const activeGroupedPermission = groupedQueue[0] ?? null;
	const activeCounterpartyPermission = counterpartyQueue[0] ?? null;
	const activeAssetPermission = assetPermissionQueue[0] ?? null;

	useEffect(() => {
		const resetPermissionQueues = () => {
			setPermissionQueue([]);
			setGroupedQueue([]);
			setCounterpartyQueue([]);
			setAssetPermissionQueue([]);
		};
		const bridge = new CWIBridge({
			onStatusChange: setStatus,
			onTransportStateChange: setTransportState,
			onPermissionRequest: (request) => {
				setPermissionQueue((prev) => {
					if (
						prev.some((existing) => existing.requestID === request.requestID)
					) {
						return prev;
					}
					return [...prev, request];
				});
			},
			onGroupedPermissionRequest: (request) => {
				setGroupedQueue((prev) => {
					if (
						prev.some((existing) => existing.requestID === request.requestID)
					) {
						return prev;
					}
					return [...prev, request];
				});
			},
			onCounterpartyPermissionRequest: (request) => {
				setCounterpartyQueue((prev) => {
					if (
						prev.some((existing) => existing.requestID === request.requestID)
					) {
						return prev;
					}
					return [...prev, request];
				});
			},
			onAssetPermissionRequest: (request) => {
				setAssetPermissionQueue((prev) => {
					if (
						prev.some((existing) => existing.requestID === request.requestID)
					) {
						return prev;
					}
					return [...prev, request];
				});
			},
			onStorageAccessRequired: () => setStorageAccessRequired(true),
			onSessionReset: resetPermissionQueues,
		});
		bridge.start();
		bridgeRef.current = bridge;

		return () => {
			bridge.stop();
			bridgeRef.current = null;
			resetPermissionQueues();
		};
	}, []);

	const grantPermission = useCallback(
		(requestID: string, grant?: CWIIndividualGrant) => {
			if (bridgeRef.current?.grantPermission(requestID, grant)) {
				setPermissionQueue((prev) =>
					prev.filter((request) => request.requestID !== requestID),
				);
			}
		},
		[],
	);

	const denyPermission = useCallback((requestID: string) => {
		if (bridgeRef.current?.denyPermission(requestID)) {
			setPermissionQueue((prev) =>
				prev.filter((request) => request.requestID !== requestID),
			);
		}
	}, []);

	const grantGroupedPermission = useCallback(
		(
			requestID: string,
			granted: Partial<GroupedPermissions>,
			expiry?: number,
		) => {
			if (
				bridgeRef.current?.grantGroupedPermission(requestID, granted, expiry)
			) {
				setGroupedQueue((prev) =>
					prev.filter((request) => request.requestID !== requestID),
				);
			}
		},
		[],
	);

	const denyGroupedPermission = useCallback((requestID: string) => {
		if (bridgeRef.current?.denyGroupedPermission(requestID)) {
			setGroupedQueue((prev) =>
				prev.filter((request) => request.requestID !== requestID),
			);
		}
	}, []);

	const grantCounterpartyPermission = useCallback(
		(
			requestID: string,
			granted: Partial<CounterpartyPermissions>,
			expiry?: number,
		) => {
			if (
				bridgeRef.current?.grantCounterpartyPermission(
					requestID,
					granted,
					expiry,
				)
			) {
				setCounterpartyQueue((prev) =>
					prev.filter((request) => request.requestID !== requestID),
				);
			}
		},
		[],
	);

	const denyCounterpartyPermission = useCallback((requestID: string) => {
		if (bridgeRef.current?.denyCounterpartyPermission(requestID)) {
			setCounterpartyQueue((prev) =>
				prev.filter((request) => request.requestID !== requestID),
			);
		}
	}, []);

	const respondToAssetPermission = useCallback(
		(requestID: string, approved: boolean) => {
			if (bridgeRef.current?.respondToAssetPermission(requestID, approved)) {
				setAssetPermissionQueue((prev) =>
					prev.filter((request) => request.requestID !== requestID),
				);
			}
		},
		[],
	);

	const retryStatus = useCallback(() => {
		bridgeRef.current?.requestStatus();
	}, []);

	const grantStorageAccess = useCallback(() => {
		const bridge = bridgeRef.current;
		if (!bridge) return;
		void bridge.retryWithGesture().then((granted) => {
			if (granted) setStorageAccessRequired(false);
		});
	}, []);

	const totalQueue =
		permissionQueue.length +
		groupedQueue.length +
		counterpartyQueue.length +
		assetPermissionQueue.length;

	return {
		status,
		activePermission,
		activeGroupedPermission,
		activeCounterpartyPermission,
		activeAssetPermission,
		queueLength: totalQueue,
		transport: transportState.transport,
		fallbackRecommended: transportState.fallbackRecommended,
		reason: transportState.reason,
		storageAccessRequired,
		grantPermission,
		denyPermission,
		grantGroupedPermission,
		denyGroupedPermission,
		grantCounterpartyPermission,
		denyCounterpartyPermission,
		respondToAssetPermission,
		grantStorageAccess,
		retryStatus,
	};
}
