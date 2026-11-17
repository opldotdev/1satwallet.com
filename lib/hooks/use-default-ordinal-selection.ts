"use client";

import {
	type Dispatch,
	type SetStateAction,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

/**
 * Ordinal selection that starts with every listed ordinal selected, once per
 * set of outpoints. It keys on the outpoints rather than the array, so a list
 * rebuilt on each render never resets the selection, and a deliberate
 * "Deselect all" stays deselected until the scan finds a different set.
 */
export function useDefaultOrdinalSelection(
	ordinals: readonly { outpoint: string }[],
): [Set<string>, Dispatch<SetStateAction<Set<string>>>] {
	const [selected, setSelected] = useState<Set<string>>(() => new Set());
	const key = useMemo(
		() => ordinals.map((item) => item.outpoint).join("|"),
		[ordinals],
	);
	const defaultedKey = useRef<string | null>(null);
	useEffect(() => {
		if (defaultedKey.current === key) return;
		defaultedKey.current = key;
		setSelected(new Set(ordinals.map((item) => item.outpoint)));
	}, [key, ordinals]);
	return [selected, setSelected];
}
