# Trend Bot dashboard

Static PWA served via GitHub Pages. Data JSON (`data/*.json`) is published by the bot
(`~/trend-bot`) — the value book on every Wednesday/Sunday check-in.
Paper-trading data only — no credentials, no real money.

Tabs:
- **Overview** — value portfolio vs the world index, open bot issues (with a copyable
  Claude command), next check-in.
- **Value** — you-vs-index chart, core ETFs + stock picks with buy reasons, alerts,
  latest monthly screen, recent paper trades.
- **Archive** — the paused Markets / Trend / Crypto trade books and why they were paused.

Static files are copied from `~/trend-bot/web/` (bump the cache name in `sw.js` when
they change).
