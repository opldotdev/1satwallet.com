import { ONESAT_MAINNET_URL, ONESAT_TESTNET_URL } from "@1sat/types";

export type Chain = "main" | "test";

/**
 * Every host the wallet talks to, per chain. Matches Yours (1color branch)
 * `endpointsOf` / `colorOverlayDefaultOf` / `handleRegistrationUrlOf` /
 * `TESTNET_FAUCET_URL` and iOS `ChainEndpoints.for(_:)`.
 */
export interface ChainEndpoints {
	/** 1Sat API: overlay, BEEF, OrdFS, owner sync, OpNS. */
	services: string;
	/** Remote wallet storage, the wallet's one active store. */
	storage: string;
	/** The account's own MessageBox: advertised, sent from, and read. */
	messagebox: string;
	/**
	 * Further MessageBoxes the PeerPay inbox is also read from, never
	 * advertised or sent from. iOS `ChainEndpoints.extraMessageBoxes`.
	 */
	extraMessageboxes: string[];
	handleRegistration: string;
	/** 1Color (BRC-207) token overlay. None runs on mainnet yet. */
	colorOverlay?: string;
	/** Free test coins. Mainnet has none. */
	faucet?: string;
}

const ENDPOINTS: Record<Chain, ChainEndpoints> = {
	main: {
		services: ONESAT_MAINNET_URL,
		storage: "https://wallet.1sat.app",
		messagebox: "https://messagebox.1sat.app",
		extraMessageboxes: ["https://messagebox.bsvblockchain.tech"],
		handleRegistration: "https://accounts.1sat.app",
	},
	test: {
		services: ONESAT_TESTNET_URL,
		storage: "https://testnet.wallet.1sat.app",
		messagebox: "https://testnet.messagebox.1sat.app",
		extraMessageboxes: [],
		handleRegistration: "https://accounts.testnet.1sat.app/",
		colorOverlay: "https://testnet.openex.dev",
		faucet: "https://faucet.bananablocks.com",
	},
};

export const endpointsOf = (chain: Chain): ChainEndpoints => ENDPOINTS[chain];

/** 1Color needs a color overlay; only chains that have one offer it. */
export const isOneColorAvailable = (chain: Chain): boolean =>
	endpointsOf(chain).colorOverlay !== undefined;

/** Every MessageBox the PeerPay inbox is read from: the own box first, once each. */
export const messageboxReadHostsOf = (chain: Chain): string[] => {
	const { messagebox, extraMessageboxes } = endpointsOf(chain);
	return [...new Set([messagebox, ...extraMessageboxes])];
};
