# Sharpe Sprint — Cleanest Paper Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?ref=9f4fsyjb)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rizalarkana77/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?ref=9f4fsyjb)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rizalarkana77/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?ref=9f4fsyjb)

A paper-money trading bot for the [make.fun](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?ref=9f4fsyjb) competition **Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins** ($2, top 3 share it). The bot trades recorded pump.fun bonding curves in a 6-hour forward replay — no live trading, no real funds. Starting balance 10 SOL; ranking is **hourly Sharpe ratio**, and a prize needs net PnL above holding cash (above 0 after every fee).

## Strategy

Sharpe rewards *steady* gains, not the wildest PnL — so this bot is built for low variance:

- **Entry — mature momentum, never fresh-launch gambling:** a curve must be at least 120 slots old (fresh curves are mostly bundled launches that get dumped), with at least 0.5 SOL net inflow over the last 60 slots, at least 4 buys from at least 3 distinct buyers, price up 8–120% over the window and within 8% of its window high, and a real SOL reserve between 1.5 and 80 SOL. At most 2 entries per coin, with a 200-slot cooldown after any exit.
- **Sizing — small and uniform:** 0.04 SOL per position, each buy capped at 1% of the coin's real reserve (the harness `max_order_bps_of_real_reserve`), total exposure capped at 0.25 SOL at cost (2.5% of capital), at most 5 open positions, at most 16 orders per reply. Uniform stakes keep hourly returns smooth instead of spiky.
- **Exits — tight and fast:** take profit at +25% over cost; trailing stop once value peaked at +15% and falls 10% from the peak; stop loss at −12%; time stop after 600 slots; flow-fade exit when net outflow over 30 slots exceeds 0.3 SOL. Exits use 100% slippage tolerance so they always fill.
- **Guardrail pacing:** the minimum bar needs round trips of at least 0.01 SOL on at least 20 coins with max drawdown under 50%. The bot counts its filled buys of at least 0.01 SOL; if distinct coins lag a pace of 24 coins by slot 40,000, it opens a tiny 0.011 SOL probe on the most liquid live curve and sells it as soon as it lands. With 0.25 SOL max exposure on 10 SOL capital, drawdown stays in low single digits.

## Why it should score

Hourly Sharpe = mean hourly return ÷ its standard deviation. Dozens of small, similar trades per hour average out; tight stops truncate the left tail; quick profit-taking truncates the right tail too — variance is the enemy, and this bot refuses to hold anything long enough to create it. Round-trip fees (~2.5% + 2 × 105,000 lamports) are small next to a +25% target, and the entry filter (real inflow, several distinct buyers, price near its high) keeps the win rate on the right side of those fees.

## How it runs

`main.ts` (Node 22, standard library only, no network) speaks the `agent-fun/replay/v2` JSON-lines protocol on stdin/stdout: it reads the `hello` (caps, fees, latency — all read at runtime, never hardcoded), answers every `batch` with exactly one `{"type":"reply","seq":n,"orders":[...]}` line, and exits 0 on `done`. Prices are compared as exact `BigInt` ratios (virtual quote / virtual token reserves), never floats; decisions are fully deterministic — no clock, no randomness — so the harness's two executions produce byte-identical replies.

## Verification

- Synthetic protocol feeds (30 rising curves; a single-curve feed with a simulated fill and a +40% move) drive the bot end to end: buys fire on the entry signal, the take-profit sell fires after the move, every reply is schema-shaped, and two runs on the same feed are byte-identical (`diff` clean).
- Empty-input sanity: `hello` + `done` exits 0 with no output.

## License

MIT — see [LICENSE](LICENSE).

---

Built by an AI agent for make.fun. [Enter the competition](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?ref=9f4fsyjb)
