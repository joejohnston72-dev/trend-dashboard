#!/usr/bin/env python3
"""Resilient OHLCV download for the trend bot.

Fixes the run-killing "'NoneType' object is not subscriptable" from yfinance:
that is Yahoo throttling. yfinance indexes the JSON body it got back
(``self._data['chart']['result'][0]``); on a 429 or an empty body the body is
None, so the subscript raises instead of reporting "rate limited".

Strategy, in order:
  1. one browser-impersonating session (curl_cffi) if installed -- Yahoo hands
     out a usable crumb far more often than it does to plain requests;
  2. strictly serial downloads (threads=False) with jittered backoff, so a
     burst never trips the limiter in the first place;
  3. per-ticker retries that treat an empty frame as failure, not success;
  4. CoinGecko as a fallback for *-USD crypto pairs.

Usage:
    from tools.fetch_prices import fetch_many
    frames, failures = fetch_many(["BTC-USD", "SOL-USD"], period="1y")
"""
from __future__ import annotations

import random
import time
from typing import Dict, Iterable, List, Tuple

import pandas as pd
import yfinance as yf

# Yahoo starts throttling a few requests in; these are deliberately unhurried.
MAX_TRIES = 4
BASE_DELAY = 2.0      # seconds, doubled per retry
INTER_TICKER_DELAY = 1.2

COINGECKO_IDS = {
    "BTC": "bitcoin",   "ETH": "ethereum",  "SOL": "solana",
    "XRP": "ripple",    "LTC": "litecoin",  "ADA": "cardano",
    "DOGE": "dogecoin", "DOT": "polkadot",  "AVAX": "avalanche-2",
    "LINK": "chainlink", "MATIC": "matic-network", "BNB": "binancecoin",
}


def _session():
    """Browser-impersonating session, or None to let yfinance use its own."""
    try:
        from curl_cffi import requests as curl_requests
        return curl_requests.Session(impersonate="chrome")
    except Exception:
        return None


def _sleep(attempt: int) -> None:
    # Jitter so two book runs starting together do not retry in lockstep.
    time.sleep(BASE_DELAY * (2 ** attempt) + random.uniform(0, 1.0))


def _normalise(df: pd.DataFrame, ticker: str) -> pd.DataFrame:
    """Flatten the MultiIndex yfinance returns even for a single ticker."""
    if isinstance(df.columns, pd.MultiIndex):
        lvl0 = df.columns.get_level_values(0)
        if ticker in set(df.columns.get_level_values(-1)):
            df = df.xs(ticker, axis=1, level=-1)
        elif ticker in set(lvl0):
            df = df.xs(ticker, axis=1, level=0)
        else:
            df.columns = lvl0
    return df


def fetch_one(ticker: str, period: str = "1y", interval: str = "1d",
              session=None) -> pd.DataFrame:
    """Download one ticker. Raises RuntimeError if every attempt fails."""
    last = "no attempt made"
    for attempt in range(MAX_TRIES):
        try:
            kwargs = dict(period=period, interval=interval, auto_adjust=False,
                          progress=False, threads=False)
            if session is not None:
                kwargs["session"] = session
            df = yf.download(ticker, **kwargs)
            if df is None or df.empty:
                # Yahoo answered with nothing -- almost always throttling.
                last = "empty response (rate limited?)"
            else:
                return _normalise(df, ticker)
        except TypeError as exc:
            # The bug in the report. Retryable: the body was None, not the data.
            last = f"throttled ({exc})"
        except Exception as exc:
            last = f"{type(exc).__name__}: {exc}"
        if attempt < MAX_TRIES - 1:
            _sleep(attempt)
    raise RuntimeError(f"{ticker}: {last}")


def fetch_coingecko(ticker: str, days: int = 365) -> pd.DataFrame:
    """Daily OHLC fallback for a *-USD crypto pair."""
    import requests

    base = ticker.split("-")[0].upper()
    coin = COINGECKO_IDS.get(base)
    if not coin:
        raise RuntimeError(f"{ticker}: no CoinGecko id for {base}")

    r = requests.get(
        f"https://api.coingecko.com/api/v3/coins/{coin}/ohlc",
        params={"vs_currency": "usd", "days": str(days)},
        timeout=30,
    )
    r.raise_for_status()
    rows = r.json()
    if not rows:
        raise RuntimeError(f"{ticker}: CoinGecko returned no rows")

    df = pd.DataFrame(rows, columns=["ts", "Open", "High", "Low", "Close"])
    df.index = pd.to_datetime(df.pop("ts"), unit="ms").dt.tz_localize(None)
    df.index.name = "Date"
    # CoinGecko's OHLC endpoint carries no volume; downstream code that needs
    # it should treat 0 as "unknown", not as a real zero-volume session.
    df["Adj Close"] = df["Close"]
    df["Volume"] = 0
    return df.groupby(df.index.normalize()).last()


def fetch_many(tickers: Iterable[str], period: str = "1y",
               interval: str = "1d", crypto_fallback: bool = True
               ) -> Tuple[Dict[str, pd.DataFrame], List[Tuple[str, str]]]:
    """Serial download of many tickers.

    Returns (frames, failures) where failures is [(ticker, reason), ...].
    One bad ticker never aborts the run.
    """
    session = _session()
    frames: Dict[str, pd.DataFrame] = {}
    failures: List[Tuple[str, str]] = []

    for i, ticker in enumerate(tickers):
        if i:
            time.sleep(INTER_TICKER_DELAY + random.uniform(0, 0.5))
        try:
            frames[ticker] = fetch_one(ticker, period, interval, session)
            continue
        except Exception as exc:
            reason = str(exc)

        if crypto_fallback and ticker.upper().endswith("-USD"):
            try:
                frames[ticker] = fetch_coingecko(ticker)
                continue
            except Exception as exc2:
                reason = f"{reason}; CoinGecko fallback: {exc2}"

        failures.append((ticker, reason))

    return frames, failures


if __name__ == "__main__":
    import sys

    args = sys.argv[1:] or ["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD",
                            "LTC-USD", "ADA-USD", "DOGE-USD"]
    frames, failures = fetch_many(args, period="6mo")
    for t, df in frames.items():
        print(f"OK   {t:10s} {len(df):4d} rows  last={df['Close'].iloc[-1]:.6g}")
    for t, why in failures:
        print(f"FAIL {t:10s} {why}")
    sys.exit(1 if failures else 0)
