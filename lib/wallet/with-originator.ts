import type { WalletInterface } from "@bsv/sdk";

/**
 * Wrap a wallet so every method call without an originator gets `originator`.
 * Port of Yours (1color branch) `src/initWallet.ts` `withOriginator`. Used to
 * run the wallet's own calls through the permissions manager as the admin
 * originator: the manager still routes `p` labels, baskets and protocols to
 * their permission modules and still encrypts wallet metadata, while its own
 * prompts are skipped for the admin.
 */
export function withOriginator(
	wallet: WalletInterface,
	originator: string,
): WalletInterface {
	return new Proxy(wallet, {
		get(target, prop, receiver) {
			const value: unknown = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				if (args.length < 2 || args[1] === undefined) {
					return value.call(target, args[0], originator);
				}
				return value.apply(target, args);
			};
		},
	});
}
