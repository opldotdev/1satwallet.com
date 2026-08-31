export interface P2PTradeItem {
	id: string;
	name: string;
	type: "ordinal" | "bsv21" | "satoshis";
	amount?: string;
	image?: string;
	txid?: string;
	vout?: number;
	satoshis?: number;
}

export type P2PRequestStatus =
	| "pending"
	| "accepted"
	| "declined"
	| "cancelled"
	| "expired";

export type P2PSessionStatus =
	| "negotiating"
	| "ready"
	| "cancelled"
	| "expired";
