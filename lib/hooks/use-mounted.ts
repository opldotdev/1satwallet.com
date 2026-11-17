"use client";

import { useSyncExternalStore } from "react";

const noSubscription = () => () => {};

/**
 * False on the server and during hydration, true once the client renders.
 * For values only the browser knows, so the first paint never mismatches.
 */
export function useMounted(): boolean {
	return useSyncExternalStore(
		noSubscription,
		() => true,
		() => false,
	);
}
