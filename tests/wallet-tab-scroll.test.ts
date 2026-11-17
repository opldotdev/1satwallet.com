import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	centredScrollLeft,
	glideDuration,
	glidePosition,
	tabInView,
} from "../lib/wallet-tab-scroll";

// A 375px phone: the row is 343px wide from x=16 and 529px of tabs long.
const row = (scrollLeft: number) => ({
	left: 16,
	scrollLeft,
	clientWidth: 343,
	scrollWidth: 529,
});

describe("centredScrollLeft", () => {
	it("centres a middle tab", () => {
		// Certificates starts 287px into the row and is 104px wide.
		assert.equal(
			centredScrollLeft(row(0), { left: 16 + 287, width: 104 }),
			287 + 52 - 343 / 2,
		);
	});

	it("gives the same target wherever the row is scrolled", () => {
		const atZero = centredScrollLeft(row(0), { left: 16 + 287, width: 104 });
		const atEnd = centredScrollLeft(row(186), {
			left: 16 + 287 - 186,
			width: 104,
		});
		assert.equal(atEnd, atZero);
	});

	it("keeps the first tab at the start, even from the far end", () => {
		// The Wallet tab, scrolled past the left edge.
		assert.equal(centredScrollLeft(row(186), { left: 16 - 186, width: 66 }), 0);
	});

	it("keeps the last tab at the end", () => {
		assert.equal(
			centredScrollLeft(row(0), { left: 16 + 457, width: 72 }),
			529 - 343,
		);
	});

	it("does not scroll a row that fits", () => {
		assert.equal(
			centredScrollLeft(
				{ left: 0, scrollLeft: 0, clientWidth: 900, scrollWidth: 900 },
				{ left: 700, width: 80 },
			),
			0,
		);
	});
});

describe("tabInView", () => {
	const box = { left: 16, right: 359 };
	it("holds for a tab wholly inside the row", () => {
		assert.equal(tabInView({ left: 16, right: 82 }, box), true);
	});
	it("allows a pixel of rounding either side", () => {
		assert.equal(tabInView({ left: 15.2, right: 359.8 }, box), true);
	});
	it("fails for a tab cut by either edge", () => {
		assert.equal(tabInView({ left: -150, right: -84 }, box), false);
		assert.equal(tabInView({ left: 320, right: 392 }, box), false);
	});
});

describe("glide", () => {
	it("starts where it was and ends exactly on the target", () => {
		assert.equal(glidePosition(186, 0, 0, 300), 186);
		assert.equal(glidePosition(186, 0, 300, 300), 0);
		assert.equal(glidePosition(186, 0, 1000, 300), 0);
	});

	it("eases out: past halfway at the halfway mark, and only ever forward", () => {
		const mid = glidePosition(0, 100, 150, 300);
		assert.ok(mid > 50 && mid < 100, `halfway is at ${mid}`);
		let last = 0;
		for (let ms = 0; ms <= 300; ms += 16) {
			const at = glidePosition(0, 100, ms, 300);
			assert.ok(at >= last, `went back at ${ms}ms`);
			last = at;
		}
	});

	it("jumps straight there with no duration", () => {
		assert.equal(glidePosition(40, 10, 0, 0), 10);
	});

	it("takes 150 to 400 ms, longer for longer hops", () => {
		assert.equal(glideDuration(0), 150);
		assert.equal(glideDuration(-20), 170);
		assert.equal(glideDuration(186), 336);
		assert.equal(glideDuration(5000), 400);
	});
});
