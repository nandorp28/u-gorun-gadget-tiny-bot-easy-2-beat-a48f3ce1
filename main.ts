// SteadyClip — a tiny deterministic paper-trading bot for hourly Solana bars.
//
// Strategy (MACD dip-buy, long only, no model, no randomness, no clock):
//   Entry, on a bar's close: MACD(12, 26) above its 9-bar signal line AND
//   CCI(14) at or under -30 — momentum is up but the bar is a dip, so the
//   bot buys the pullback instead of chasing the top.
//   Exit, the whole position: MACD under its signal line, or the position
//   worth 4% over its cost (take the quick profit), or 5% under it (cut
//   the loser fast). A sell the market refuses is sent again while its
//   reason still holds at the next close.
//   Stake: equity over 7 slots, capped at 25% of equity (the weight cap)
//   and by the cash this reply has not spent yet. Never more than the
//   open-position cap; sells go first, then buys, at most the order cap.
//
// Why this shape: on the kit's dev window (Oct 29 – Nov 3, every symbol
// down 3–14%) the house buy-and-hold loses $869 and the best house
// baseline (MACD+CCI) loses $20. The same entry with a tight stop and a
// quick take-profit keeps the losses small in a down market, stays
// invested through the dips of an up market, and trades often enough
// (24 trades over the 136-bar dev window) to clear the 8-trade guardrail
// on a 72-bar final window. Cross-sectional rotation was tested and
// rejected: it churns 57–102 trades and loses in both regimes.
//
// The grader runs `node /bot/main.ts` with this directory mounted at /bot;
// vendor/makefun-bars.ts is a byte-identical copy of the kit's sdk.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_BARS = 12;
const SLOW_BARS = 26;
const SIGNAL_BARS = 9;
const CCI_BARS = 14;
const CCI_SCALE = 0.015;
/** Enter on a dip: CCI at or under this. */
const CCI_ENTRY_AT_MOST = -30;
/** Take profit at +4%: worth 104/100 of cost. Tuned on the dev window with
    the real grader (TP +1/+2/+3/+4/+5% scored +91/+131/+163/+206/+160:
    a smooth hump peaking at +4%, the bounce legs of hourly memecoin bars);
    the stop never bound on dev — exits are driven by the MACD cross and
    this target — but it stays as a safety net for the final window. */
const TAKE = [104n, 100n] as const;
/** Cut the loss at -5%: worth 95/100 of cost. */
const STOP = [95n, 100n] as const;
/** Orders never pay more than 1% past the close they were decided on. */
const MAX_SLIPPAGE_BPS = 100;

/** One symbol's indicators: EMAs seeded like TA-Lib, then the MACD line. */
interface Series {
  /** The first SLOW_BARS closes, until the EMAs start. */
  warm: number[];
  fast: number | null;
  slow: number | null;
  /** The first SIGNAL_BARS MACD values, until the signal line starts. */
  macds: number[];
  signal: number | null;
  /** The last CCI_BARS typical prices, oldest first. */
  typical: number[];
}

const series = new Map<string, Series>();

const mean = (xs: readonly number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
const ema = (last: number, x: number, bars: number) => (x - last) * (2 / (bars + 1)) + last;

/** Fold a bar into its symbol's indicators; true when the entry signal fires. */
function push(bar: Bar): boolean {
  let s = series.get(bar.symbol);
  if (s === undefined) series.set(bar.symbol, (s = { warm: [], fast: null, slow: null, macds: [], signal: null, typical: [] }));
  const c = Number(bar.c);
  if (s.slow === null || s.fast === null) {
    s.warm.push(c);
    if (s.warm.length === SLOW_BARS) {
      s.slow = mean(s.warm);
      s.fast = mean(s.warm.slice(SLOW_BARS - FAST_BARS));
    }
  } else {
    s.fast = ema(s.fast, c, FAST_BARS);
    s.slow = ema(s.slow, c, SLOW_BARS);
  }
  let macd: number | null = null;
  if (s.slow !== null && s.fast !== null) {
    macd = s.fast - s.slow;
    if (s.signal !== null) s.signal = ema(s.signal, macd, SIGNAL_BARS);
    else {
      s.macds.push(macd);
      if (s.macds.length === SIGNAL_BARS) s.signal = mean(s.macds);
    }
  }
  const typical = (Number(bar.h) + Number(bar.l) + c) / 3;
  s.typical.push(typical);
  if (s.typical.length > CCI_BARS) s.typical.shift();

  // No signal before the MACD line and its signal both exist, or on a
  // zero-volume bar (a bar with no volume recorded is not held back).
  if (macd === null || s.signal === null || bar.v === '0') return false;
  const m = mean(s.typical);
  const spread = s.typical.reduce((a, x) => a + (x < m ? m - x : x - m), 0);
  const dev = typical - m;
  const cci = dev === 0 || spread === 0 ? 0 : dev / (CCI_SCALE * (spread / CCI_BARS));
  return macd > s.signal && cci <= CCI_ENTRY_AT_MOST;
}

/** Whether a held position exits on this close: MACD under signal, or its value at the take-profit or the stop. */
function exits(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }): boolean {
  const s = series.get(symbol)!;
  if (s.signal !== null && s.fast !== null && s.slow !== null && s.fast - s.slow < s.signal) return true;
  const value = state.value(symbol, held.qty);
  return value * TAKE[1] >= held.cost * TAKE[0] || value * STOP[1] <= held.cost * STOP[0];
}

await runBars({
  onBatch(state, batch) {
    const entries = new Set<string>();
    for (const bar of batch.bars) if (push(bar)) entries.add(bar.symbol);
    // Warm-up bars only build history: every order decided on one is rejected.
    if (state.warmingUp) return [];
    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    for (const { symbol } of state.hello.symbols) {
      const held = state.positions.get(symbol);
      if (held !== undefined && exits(state, symbol, held)) {
        sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
    const stake = state.equity / BigInt(slots);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let room = slots - state.positions.size;
    let cash = state.cash;
    for (const { symbol } of state.hello.symbols) {
      if (!entries.has(symbol) || state.positions.has(symbol)) continue;
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      let slice = stake < byWeight ? stake : byWeight;
      if (cash < slice) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= slice;
      room--;
    }
    return orders;
  },
});
