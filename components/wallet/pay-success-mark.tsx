// Inline copy of OneSatWallet/Resources/PaySuccessMark.svg, the motion source of truth.
// Keep geometry/timing in sync with the native PaySuccessMotion and PaySuccessMark.
export const PAY_SUCCESS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 220" width="220" height="220" aria-hidden="true" focusable="false" class="pay-success-mark">
  <style>
    .pay-success-mark { color: var(--chart-4); overflow: visible; }
    .pay-success-mark .disk { transform-origin: 110px 110px; animation: pay-disk 180ms ease-out both; }
    .pay-success-mark .glow { transform-origin: 110px 110px; opacity: .12; animation: pay-glow 1000ms ease-out both; }
    .pay-success-mark .check { stroke-dasharray: 1; stroke-dashoffset: 0; animation: pay-check 240ms 80ms linear both; }
    .pay-success-mark .tick { transform: translateX(84px); opacity: .8; animation: pay-burst 540ms 160ms ease-out both; }
    .pay-success-card .pay-success-copy { animation: pay-copy 220ms 280ms ease-out both; }
    @keyframes pay-disk { from { transform: scale(.62); } to { transform: scale(1); } }
    @keyframes pay-glow { 0% { opacity: 0; transform: scale(.62); } 18% { opacity: .28; transform: scale(1); } 100% { opacity: .12; transform: scale(1); } }
    @keyframes pay-check { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
    @keyframes pay-burst { 0% { transform: translateX(58px) rotate(-8deg); opacity: 0; } 65% { transform: translateX(90px) rotate(4deg); opacity: 1; } 100% { transform: translateX(84px) rotate(0deg); opacity: .8; } }
    @keyframes pay-copy { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @media (prefers-reduced-motion: reduce) {
      .pay-success-mark .disk, .pay-success-mark .glow, .pay-success-mark .check, .pay-success-mark .tick, .pay-success-card .pay-success-copy { animation: none; }
    }
  </style>
  <circle class="glow" cx="110" cy="110" r="61" fill="currentColor" style="filter: blur(8px)"/>
  <circle class="disk" cx="110" cy="110" r="48" fill="currentColor"/>
  <path class="check" d="M88 110 L103 125 L133 95" pathLength="1" fill="none" stroke="white" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
  <g transform="translate(110 110)" fill="none" stroke-width="4" stroke-linecap="round">
    <g transform="rotate(-90)" stroke="var(--primary)"><path class="tick" d="M0 0 H10"/></g>
    <g transform="rotate(-54)" stroke="var(--chart-3)"><path class="tick" d="M0 0 H10"/></g>
    <g transform="rotate(-18)" stroke="var(--chart-4)"><path class="tick" d="M0 0 H10"/></g>
    <g transform="rotate(18)" stroke="var(--primary)"><path class="tick" d="M0 0 H10"/></g>
    <g transform="rotate(54)" stroke="var(--chart-3)"><path class="tick" d="M0 0 H10"/></g>
    <g transform="rotate(90)" stroke="var(--chart-4)"><path class="tick" d="M0 0 H10"/></g>
    <g transform="rotate(126)" stroke="var(--primary)"><path class="tick" d="M0 0 H10"/></g>
    <g transform="rotate(162)" stroke="var(--chart-3)"><path class="tick" d="M0 0 H10"/></g>
    <g transform="rotate(198)" stroke="var(--chart-4)"><path class="tick" d="M0 0 H10"/></g>
    <g transform="rotate(234)" stroke="var(--primary)"><path class="tick" d="M0 0 H10"/></g>
  </g>
</svg>`;

export function PaySuccessMark() {
	return (
		// The markup is a bundled constant, never transaction or user input.
		<div
			className="mx-auto size-[220px]"
			dangerouslySetInnerHTML={{ __html: PAY_SUCCESS_SVG }}
		/>
	);
}
