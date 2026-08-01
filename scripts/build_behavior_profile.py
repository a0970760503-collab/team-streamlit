"""Create a privacy-minimised behaviour profile from a MaiCoin CSV export.

The input export is intentionally never copied into this repository.  The
generated JSON contains aggregate counts and ratios only, so the browser and
AI endpoint never receive individual orders, balances, or deposit amounts.
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path


TRADE_ACTIONS = {"buy", "sell"}


def clamp_score(value: float) -> int:
    return max(0, min(100, round(value)))


def parse_row(row: dict[str, str]) -> dict[str, object]:
    return {
        "time": datetime.fromtimestamp(int(row["timestamp"]) / 1000, tz=timezone.utc),
        "currency": row["currency"].strip().upper(),
        "price": float(row["price"]),
        "action": row["action"].strip().lower(),
        "change": float(row["change"]),
    }


def build_profile(csv_path: Path) -> dict[str, object]:
    with csv_path.open("r", encoding="utf-8-sig", newline="") as source:
        rows = sorted((parse_row(row) for row in csv.DictReader(source)), key=lambda row: row["time"])
    if not rows:
        raise ValueError("CSV does not contain any records.")

    trades = [row for row in rows if row["action"] in TRADE_ACTIONS]
    if not trades:
        raise ValueError("CSV does not contain buy or sell records.")

    last_trade: dict[str, dict[str, object]] = {}
    buys_with_reference = buys_after_rise = opposite_side_within_day = 0
    turnover_by_currency: defaultdict[str, float] = defaultdict(float)
    daily_trade_count: Counter[str] = Counter()
    for trade in trades:
        currency = str(trade["currency"])
        action = str(trade["action"])
        price = float(trade["price"])
        previous = last_trade.get(currency)
        if action == "buy" and previous and float(previous["price"]) > 0:
            buys_with_reference += 1
            if price > float(previous["price"]) * 1.005:
                buys_after_rise += 1
        if previous and previous["action"] != action:
            elapsed_hours = (trade["time"] - previous["time"]).total_seconds() / 3600
            if elapsed_hours <= 24:
                opposite_side_within_day += 1
        turnover_by_currency[currency] += abs(float(trade["change"]) * price)
        daily_trade_count[trade["time"].date().isoformat()] += 1
        last_trade[currency] = trade

    active_days = len(daily_trade_count)
    total_turnover = sum(turnover_by_currency.values())
    top_asset, top_turnover = max(turnover_by_currency.items(), key=lambda item: item[1])
    buy_after_rise_rate = buys_after_rise / buys_with_reference if buys_with_reference else 0.0
    opposite_side_rate = opposite_side_within_day / max(1, len(trades) - 1)
    trades_per_active_day = len(trades) / max(1, active_days)
    top_asset_turnover_share = top_turnover / total_turnover if total_turnover else 0.0

    return {
        "schema": "maicoin-behavior-profile/v1",
        "source": "MaiCoin CSV import (aggregated locally)",
        "privacy": "No individual transactions, balances, deposit amounts, API keys, or account identifiers are included.",
        "periodUtc": {"from": rows[0]["time"].isoformat(), "to": rows[-1]["time"].isoformat()},
        "trades": {
            "total": len(trades), "buyCount": sum(row["action"] == "buy" for row in trades),
            "sellCount": sum(row["action"] == "sell" for row in trades), "activeDays": active_days,
        },
        "signals": {
            "buyAfterPriceRiseRate": round(buy_after_rise_rate, 4),
            "oppositeSideWithin24hRate": round(opposite_side_rate, 4),
            "tradesPerActiveDay": round(trades_per_active_day, 2),
            "topAssetByTurnover": top_asset,
            "topAssetTurnoverShare": round(top_asset_turnover_share, 4),
        },
        "scores": {
            "fomo": clamp_score(buy_after_rise_rate * 100),
            "switching": clamp_score(opposite_side_rate * 100),
            "intensity": clamp_score(trades_per_active_day / 15 * 100),
            "concentration": clamp_score(top_asset_turnover_share * 100),
        },
        "limitations": [
            "The export does not include order intent, stop-loss orders, cancellations, or the user's trading plan.",
            "Scores are descriptive behaviour signals, not performance ratings or investment recommendations.",
            "Price changes are compared only with the user's previous trade in the same asset, not a full market-price series.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a redacted MaiCoin behaviour profile.")
    parser.add_argument("--input", required=True, type=Path, help="MaiCoin CSV export path")
    parser.add_argument("--output", default=Path("web/user_behavior_profile.json"), type=Path)
    args = parser.parse_args()
    profile = build_profile(args.input)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(profile, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote redacted behaviour profile to {args.output}")


if __name__ == "__main__":
    main()
