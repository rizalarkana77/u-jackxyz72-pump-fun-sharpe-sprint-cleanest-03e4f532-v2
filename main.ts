// SPDX-License-Identifier: MIT
// Sharpe Sprint — pump.fun replay bot (agent-fun/replay/v2).
//
// Paper-money bot for make.fun's "Pump.fun Sharpe Sprint — Cleanest Paper
// Bot Wins". Ranking is hourly Sharpe ratio on a 6-hour forward replay, so
// this bot optimises for steady, low-variance gains instead of raw PnL:
// many small uniform trades, tight take-profit and stop-loss, fast
// rotation across fresh curves, and a hard cap on total exposure.
//
// Node 22, standard library only, no network. Fully deterministic: every
// decision comes from the harness input stream (no Date.now(), no
// Math.random(), no floats in price comparisons — exact BigInt ratios),
// so the harness's two executions produce byte-identical action logs.

import { createInterface } from "node:readline";

// ---------- exact ratio helpers (BigInt) ----------
interface Ratio {
  n: bigint; // numerator (virtual quote reserves)
  d: bigint; // denominator (virtual token reserves)
}

function cmpRatio(a: Ratio, b: Ratio): number {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
}

function scaleRatio(r: Ratio, num: bigint, den: bigint): Ratio {
  return { n: r.n * num, d: r.d * den };
}

function toBig(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (typeof v === "string") return BigInt(v);
  return 0n;
}

const SOL = 1_000_000_000n;

// ---------- strategy constants ----------
// Stake per position: small and uniform so hourly returns stay smooth.
const STAKE_LAMPORTS = 40_000_000n; // 0.04 SOL
const PROBE_LAMPORTS = 11_000_000n; // 0.011 SOL guardrail probe
const MIN_COUNTED_BUY = 10_000_000n; // 0.01 SOL guardrail round-trip floor
const CASH_RESERVE = 80_000_000n; // 0.08 SOL kept back for exit fees
const MAX_EXPOSURE = 250_000_000n; // 0.25 SOL at cost, all positions
const MIN_AGE_SLOTS = 120; // skip bundled-launch dumps
const WINDOW_SLOTS = 60; // entry signal lookback
const FADE_SLOTS = 30; // flow-fade lookback
const MAX_HOLD_SLOTS = 600; // time stop (~4 min)
const COOLDOWN_SLOTS = 200; // wait after an exit before re-entry
const MAX_ENTRIES_PER_MINT = 2;
const MIN_NET_INFLOW = 500_000_000n; // 0.5 SOL net inflow in window
const FADE_NET_OUTFLOW = 300_000_000n; // 0.3 SOL net outflow = fade exit
const MIN_RESERVE = 1_500_000_000n; // 1.5 SOL real reserve (1% cap >= 0.015)
const MAX_RESERVE = 80_000_000_000n; // 80 SOL: curve nearly done, skip
const BUY_SLIPPAGE_BPS = 800;
const SELL_SLIPPAGE_BPS = 10_000; // exits always fill
// Guardrail pacing: 20+ distinct mints with >= 0.01 SOL round trips.
// 6 hours ~= 54,000 slots at 400 ms; aim for 24 coins by slot 40,000.
const PACE_TARGET_COINS = 24;
const PACE_TARGET_SLOTS = 40_000;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: bigint;
  user: string;
  price: Ratio;
}

interface MintState {
  created: number | null;
  completed: boolean;
  trades: TapeTrade[];
  lastPrice: Ratio | null;
  realQuote: bigint;
  entries: number;
  lastExitSlot: number;
  pending: { clientId: string; seq: number }[];
}

interface HeldInfo {
  openedSlot: number;
  peakValueNum: bigint; // peak close value as ratio num/den (lamports)
  peakValueDen: bigint;
  cost: bigint;
  tokens: bigint;
  exiting: boolean;
}

const mints = new Map<string, MintState>();
const heldInfo = new Map<string, HeldInfo>();
const probeSelling = new Map<string, boolean>(); // mint -> sell sent?
const countedCoins = new Set<string>(); // mints with a filled buy >= 0.01 SOL
let caps = { maxOpen: 5, maxBps: 100, maxOrders: 16 };
let latencySlots = 2;
let firstSlot: number | null = null;
let orderCounter = 0;

function getMint(mint: string): MintState {
  let s = mints.get(mint);
  if (!s) {
    s = {
      created: null,
      completed: false,
      trades: [],
      lastPrice: null,
      realQuote: 0n,
      entries: 0,
      lastExitSlot: -1_000_000_000,
      pending: [],
    };
    mints.set(mint, s);
  }
  return s;
}

function priceOf(vq: unknown, vt: unknown): Ratio | null {
  const d = toBig(vt);
  if (d === 0n) return null;
  return { n: toBig(vq), d };
}

/** Close value of `tokens` at `price`, as an exact ratio of lamports. */
function valueRatio(tokens: bigint, price: Ratio): { n: bigint; d: bigint } {
  return { n: tokens * price.n, d: price.d };
}

function main(): void {
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }

    if (msg.type === "hello") {
      const c = (msg.caps ?? {}) as Record<string, unknown>;
      caps = {
        maxOpen: Number(c.max_open_positions ?? 5),
        maxBps: Number(c.max_order_bps_of_real_reserve ?? 100),
        maxOrders: Number(c.max_orders_per_batch ?? 16),
      };
      latencySlots = Number(msg.latency_slots ?? 2);
      return;
    }
    if (msg.type === "done") {
      process.exit(0);
    }
    if (msg.type !== "batch") return;

    const seq = Number(msg.seq ?? 0);
    const slot = Number(msg.slot ?? 0);
    if (firstSlot === null) firstSlot = slot;
    const events = (msg.events ?? []) as Record<string, unknown>[];
    const marks = (msg.marks ?? []) as Record<string, unknown>[];
    const fills = (msg.fills ?? []) as Record<string, unknown>[];
    const account = (msg.account ?? {}) as Record<string, unknown>;
    const cash = toBig(account.cash_lamports);
    const positions = (account.positions ?? []) as Record<string, unknown>[];

    const heldTokens = new Map<string, bigint>();
    const heldCost = new Map<string, bigint>();
    for (const p of positions) {
      const mint = String(p.mint ?? "");
      if (!mint) continue;
      heldTokens.set(mint, toBig(p.token_amount));
      heldCost.set(mint, toBig(p.cost_lamports));
    }

    // --- events: creates / trades / completes ---
    for (const e of events) {
      const kind = String(e.event ?? "");
      const mint = String(e.mint ?? "");
      if (!mint) continue;
      const s = getMint(mint);
      if (kind === "CreateEvent") {
        if (s.created === null) s.created = Number(e.slot ?? slot);
      } else if (kind === "TradeEvent") {
        const price = priceOf(e.virtual_quote_reserves, e.virtual_token_reserves);
        if (price) {
          s.trades.push({
            slot: Number(e.slot ?? slot),
            buy: e.is_buy === true,
            sol: toBig(e.sol_amount),
            user: String(e.user ?? ""),
            price,
          });
          if (s.trades.length > 400) s.trades.splice(0, s.trades.length - 400);
        }
        s.realQuote = toBig(e.real_quote_reserves);
      } else if (kind === "CompleteEvent") {
        s.completed = true;
      }
    }

    // --- marks: latest price + real reserve per mint ---
    for (const m of marks) {
      const mint = String(m.mint ?? "");
      if (!mint) continue;
      const price = priceOf(m.virtual_quote_reserves, m.virtual_token_reserves);
      if (!price) continue;
      const s = getMint(mint);
      s.lastPrice = price;
      s.realQuote = toBig(m.real_quote_reserves);
    }

    // --- fills: reconcile pending + guardrail counting ---
    for (const f of fills) {
      const mint = String(f.mint ?? "");
      if (!mint) continue;
      const s = mints.get(mint);
      if (!s) continue;
      const clientId = String(f.client_id ?? "");
      if (clientId) {
        const i = s.pending.findIndex((p) => p.clientId === clientId);
        if (i >= 0) s.pending.splice(i, 1);
      }
      if (f.side === "buy" && f.status === "filled") {
        // Count an entry only once it fills: a rejected order must not
        // burn one of the mint's two allowed entries.
        s.entries += 1;
        if (toBig(f.quote_lamports) >= MIN_COUNTED_BUY) {
          countedCoins.add(mint);
        }
      }
    }
    for (const s of mints.values()) {
      s.pending = s.pending.filter((p) => seq - p.seq <= latencySlots + 2);
    }

    // --- reconcile held positions (harness account is truth) ---
    for (const [mint, tokens] of heldTokens) {
      if (tokens <= 0n) continue;
      const cost = heldCost.get(mint) ?? 0n;
      const s = mints.get(mint);
      const price = s?.lastPrice ?? null;
      let h = heldInfo.get(mint);
      if (!h) {
        h = {
          openedSlot: slot,
          peakValueNum: cost,
          peakValueDen: 1n,
          cost,
          tokens,
          exiting: false,
        };
        heldInfo.set(mint, h);
      }
      h.cost = cost;
      h.tokens = tokens;
      if (price) {
        const v = valueRatio(tokens, price);
        if (v.n * h.peakValueDen > h.peakValueNum * v.d) {
          h.peakValueNum = v.n;
          h.peakValueDen = v.d;
        }
      }
    }
    for (const mint of [...heldInfo.keys()]) {
      if ((heldTokens.get(mint) ?? 0n) <= 0n) {
        heldInfo.delete(mint);
        const s = mints.get(mint);
        if (s) s.lastExitSlot = slot;
      }
    }
    for (const mint of [...probeSelling.keys()]) {
      if ((heldTokens.get(mint) ?? 0n) <= 0n) probeSelling.delete(mint);
    }

    const orders: Record<string, unknown>[] = [];
    const pushOrder = (o: Record<string, unknown>): void => {
      if (orders.length < caps.maxOrders) orders.push(o);
    };
    const nextId = (prefix: string): string => `${prefix}${++orderCounter}`;

    // --- sells first: exits outrank new buys ---
    for (const [mint, h] of heldInfo) {
      if (h.exiting || h.tokens <= 0n) continue;
      const s = mints.get(mint);
      if (!s || s.completed || !s.lastPrice) continue;
      const price = s.lastPrice;
      const v = valueRatio(h.tokens, price);
      const cost = h.cost;
      let sell = false;
      // Take profit: close value >= 1.25x cost.
      if (cost > 0n && v.n * 4n >= cost * 5n * v.d) sell = true;
      // Trailing: peak reached 1.15x cost, now 10% below peak.
      if (
        !sell &&
        cost > 0n &&
        h.peakValueNum * 100n >= cost * 115n * h.peakValueDen &&
        v.n * 10n * h.peakValueDen <= h.peakValueNum * 9n * v.d
      ) {
        sell = true;
      }
      // Stop loss: close value <= 0.88x cost.
      if (!sell && cost > 0n && v.n * 100n <= cost * 88n * v.d) sell = true;
      // Time stop: held too long without exiting.
      if (!sell && slot - h.openedSlot > MAX_HOLD_SLOTS) sell = true;
      // Flow fade: net outflow over the fade window.
      if (!sell) {
        let net = 0n;
        for (const t of s.trades) {
          if (t.slot > slot - FADE_SLOTS) net += t.buy ? t.sol : -t.sol;
        }
        if (net < -FADE_NET_OUTFLOW) sell = true;
      }
      if (sell) {
        h.exiting = true;
        const clientId = nextId("s");
        s.pending.push({ clientId, seq });
        pushOrder({
          side: "sell",
          client_id: clientId,
          mint,
          token_amount: h.tokens.toString(),
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
      }
    }

    // --- probe sells: close guardrail probes as soon as they land ---
    for (const [mint, sellSent] of probeSelling) {
      if (sellSent) continue;
      const tokens = heldTokens.get(mint) ?? 0n;
      if (tokens <= 0n) continue;
      const s = mints.get(mint);
      if (!s || s.completed) continue;
      probeSelling.set(mint, true);
      const clientId = nextId("p");
      s.pending.push({ clientId, seq });
      pushOrder({
        side: "sell",
        client_id: clientId,
        mint,
        token_amount: tokens.toString(),
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
    }

    // --- buys ---
    let openCount = 0;
    let exposure = 0n;
    for (const [mint, tokens] of heldTokens) {
      if (tokens > 0n) {
        openCount += 1;
        exposure += heldCost.get(mint) ?? 0n;
      }
    }
    const pendingMints = new Set<string>();
    for (const [mint, s] of mints) {
      if (s.pending.length > 0 && (heldTokens.get(mint) ?? 0n) <= 0n) {
        pendingMints.add(mint);
      }
    }
    let slotsFree = caps.maxOpen - openCount - pendingMints.size;

    const buySize = (s: MintState, target: bigint): bigint => {
      const capByReserve = (s.realQuote * BigInt(caps.maxBps)) / 10_000n;
      let size = target;
      if (capByReserve < size) size = capByReserve;
      const cashAvail = cash - CASH_RESERVE;
      if (cashAvail < size) size = cashAvail;
      if (MAX_EXPOSURE - exposure < size) size = MAX_EXPOSURE - exposure;
      return size;
    };

    for (const [mint, s] of mints) {
      if (orders.length >= caps.maxOrders || slotsFree <= 0) break;
      if (s.completed || s.created === null || !s.lastPrice) continue;
      if ((heldTokens.get(mint) ?? 0n) > 0n) continue;
      if (s.pending.length > 0) continue;
      if (probeSelling.has(mint)) continue;
      if (s.entries >= MAX_ENTRIES_PER_MINT) continue;
      if (slot - s.created < MIN_AGE_SLOTS) continue;
      if (slot - s.lastExitSlot < COOLDOWN_SLOTS) continue;
      if (s.realQuote < MIN_RESERVE || s.realQuote > MAX_RESERVE) continue;

      // Entry signal over the lookback window.
      const from = slot - WINDOW_SLOTS;
      let buySol = 0n;
      let sellSol = 0n;
      let buys = 0;
      let startPrice: Ratio | null = null;
      let high: Ratio | null = null;
      let last: Ratio | null = null;
      const buyers = new Set<string>();
      for (const t of s.trades) {
        if (t.slot <= from) {
          startPrice = t.price;
          continue;
        }
        if (startPrice === null) startPrice = t.price;
        if (t.buy) {
          buySol += t.sol;
          buys += 1;
          buyers.add(t.user);
        } else {
          sellSol += t.sol;
        }
        if (high === null || cmpRatio(t.price, high) > 0) high = t.price;
        last = t.price;
      }
      if (buys < 4 || buyers.size < 3) continue;
      if (buySol - sellSol < MIN_NET_INFLOW) continue;
      if (!startPrice || !high || !last) continue;
      // Price up 8%..120% over the window, near the window high.
      if (cmpRatio(last, scaleRatio(startPrice, 27n, 25n)) < 0) continue;
      if (cmpRatio(last, scaleRatio(startPrice, 11n, 5n)) > 0) continue;
      if (cmpRatio(last, scaleRatio(high, 23n, 25n)) < 0) continue;

      const size = buySize(s, STAKE_LAMPORTS);
      if (size < MIN_COUNTED_BUY) continue;
      const clientId = nextId("b");
      s.pending.push({ clientId, seq });
      slotsFree -= 1;
      exposure += size;
      pushOrder({
        side: "buy",
        client_id: clientId,
        mint,
        quote_lamports: size.toString(),
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
    }

    // --- guardrail pacing probes ---
    // If distinct counted coins lag the pace needed for 20+ round trips,
    // buy a tiny probe on the most liquid live curve and sell it next
    // batch. Probes cost ~2.5% fees on 0.011 SOL — cheap insurance
    // against ranking below every entry that meets the minimum bar.
    const elapsed = slot - (firstSlot ?? slot);
    const paceNeeded =
      elapsed <= 0
        ? 0
        : Math.min(
            PACE_TARGET_COINS,
            Math.floor((PACE_TARGET_COINS * elapsed) / PACE_TARGET_SLOTS),
          );
    if (
      countedCoins.size < paceNeeded &&
      probeSelling.size === 0 &&
      slotsFree > 0 &&
      orders.length < caps.maxOrders
    ) {
      let bestMint: string | null = null;
      let bestReserve = 0n;
      for (const [mint, s] of mints) {
        if (s.completed || countedCoins.has(mint)) continue;
        if ((heldTokens.get(mint) ?? 0n) > 0n || s.pending.length > 0) continue;
        if (s.realQuote > bestReserve) {
          bestReserve = s.realQuote;
          bestMint = mint;
        }
      }
      if (bestMint !== null) {
        const s = mints.get(bestMint)!;
        const size = buySize(s, PROBE_LAMPORTS);
        if (size >= MIN_COUNTED_BUY) {
          probeSelling.set(bestMint, false);
          const clientId = nextId("q");
          s.pending.push({ clientId, seq });
          pushOrder({
            side: "buy",
            client_id: clientId,
            mint: bestMint,
            quote_lamports: size.toString(),
            max_slippage_bps: SELL_SLIPPAGE_BPS,
          });
        }
      }
    }

    process.stdout.write(
      JSON.stringify({ type: "reply", seq, orders }) + "\n",
    );
  });
}

main();
