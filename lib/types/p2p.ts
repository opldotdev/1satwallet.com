interface P2PTradeItemDisplay {
	id: string;
	name: string;
	image?: string;
}

export interface P2POrdinalTradeItem extends P2PTradeItemDisplay {
	type: "ordinal";
	txid: string;
	vout: number;
	satoshis?: number;
}

/**
 * A value-based BSV-21 offer. `id` identifies the token deployment and
 * `amount` is an atomic-unit decimal integer. Spendable tip outpoints are
 * deliberately selected later, during settlement.
 */
export interface P2PBsv21TradeItem extends P2PTradeItemDisplay {
	type: "bsv21";
	amount: string;
	decimals?: number;
}

export interface P2PSatoshisTradeItem extends P2PTradeItemDisplay {
	type: "satoshis";
	satoshis: number;
}

export type P2PTradeItem =
	| P2POrdinalTradeItem
	| P2PBsv21TradeItem
	| P2PSatoshisTradeItem;

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
