"""Local-only server for testing the frontend without AWS or API keys.

Run from the repository root:
    python scripts/local_demo_server.py
Then open http://127.0.0.1:8765
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
WEB_ROOT = ROOT / "web"
COMMUNITY_MESSAGES: dict[str, list[dict[str, str]]] = {}
MAX_API_URL = "https://max-api.maicoin.com"
MARKET_PATTERN = re.compile(r"^[a-z0-9]{3,16}$")


def valid_market(value: str) -> str:
    market = str(value).lower().strip()
    if not MARKET_PATTERN.fullmatch(market):
        raise ValueError("Invalid market symbol.")
    return market


def max_json(path: str, query: dict[str, str] | None = None):
    url = f"{MAX_API_URL}{path}"
    if query:
        from urllib.parse import urlencode
        url = f"{url}?{urlencode(query)}"
    request = Request(url, headers={"User-Agent": "AI-Investment-Committee-LocalDemo/1.0"})
    with urlopen(request, timeout=8) as response:
        return json.loads(response.read().decode("utf-8"))


def market_snapshot(market: str):
    ticker = max_json(f"/api/v2/tickers/{market}")
    last, opening = float(ticker["last"]), float(ticker["open"])
    return {"price": last, "change24h": round((last - opening) / opening * 100, 2) if opening else None,
            "volume": float(ticker.get("vol", 0) or 0), "dataSource": "live"}


def max_proxy(params: dict[str, list[str]]):
    path = params.get("path", [""])[0]
    market = valid_market(params.get("market", ["btcusdt"])[0])
    if path == "/api/v2/tickers":
        return max_json(path)
    if re.fullmatch(r"/api/v2/tickers/[a-z0-9]{3,16}", path):
        return max_json(path)
    if path == "/api/v2/depth":
        limit = max(1, min(500, int(params.get("limit", ["35"])[0])))
        return max_json(path, {"market": market, "limit": str(limit)})
    if path == "/api/v2/k":
        period = int(params.get("period", ["60"])[0])
        if period not in {1, 5, 15, 60, 240, 1440, 10080}:
            raise ValueError("Unsupported candle period.")
        limit = max(1, min(500, int(params.get("limit", ["35"])[0])))
        return max_json(path, {"market": market, "limit": str(limit), "period": str(period)})
    raise ValueError("Unsupported proxy path.")


def demo_replies(market: str, message: str) -> dict[str, str]:
    topic = " ".join(message.split())[:160]
    market = market.upper()
    return {
        "technical": f"[Demo mode] {market}: review price trend, volume, and volatility before reaching a conclusion. This local response uses no external AI service.",
        "risk": f"[Demo mode] Risk view on '{topic}': uncertainty is high in fast-moving markets. Use predefined limits and do not treat a demo as investment advice.",
        "chair": f"[Demo mode] The committee recorded: '{topic}'. Demonstration conclusion: HOLD and continue observing. This is educational only, not a trading recommendation.",
    }


class DemoHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def json_response(self, status: int, payload: object):
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        try:
            value = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            value = None
        if not isinstance(value, dict):
            raise ValueError("Request body must be a JSON object.")
        return value

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        route = urlparse(self.path)
        params = parse_qs(route.query)
        if route.path == "/api/community":
            market = params.get("market", ["btcusdt"])[0].lower()
            return self.json_response(HTTPStatus.OK, {"messages": COMMUNITY_MESSAGES.get(market, [])})
        if route.path == "/api/market":
            try:
                return self.json_response(HTTPStatus.OK, market_snapshot(valid_market(params.get("market", ["btcusdt"])[0])))
            except Exception as error:
                return self.json_response(HTTPStatus.OK, {"price": None, "change24h": None, "volume": None, "dataSource": "unavailable", "error": str(error)})
        if route.path == "/api/proxy":
            try:
                return self.json_response(HTTPStatus.OK, max_proxy(params))
            except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
                return self.json_response(HTTPStatus.BAD_GATEWAY, {"error": f"MAX data unavailable: {error}"})
        if route.path == "/api/news":
            return self.json_response(HTTPStatus.OK, {"status": "success", "news": []})
        return super().do_GET()

    def do_POST(self):
        route = urlparse(self.path).path
        try:
            payload = self.read_json()
            if route == "/api/debate-message":
                market = str(payload.get("market", "btcusdt")).lower()
                message = str(payload.get("message", "")).strip()
                if not message:
                    raise ValueError("Message is required.")
                replies = demo_replies(market, message)
                debates = [
                    {"agent": "tech", "icon": "T", "name": "Technical Agent (Demo)", "color": "var(--primary)", "text": replies["technical"]},
                    {"agent": "risk", "icon": "R", "name": "Risk Agent (Demo)", "color": "var(--warning)", "text": replies["risk"]},
                    {"agent": "chair", "icon": "C", "name": "Chair Agent (Demo)", "color": "#ffd700", "text": replies["chair"]},
                ]
                return self.json_response(HTTPStatus.OK, {"mode": "demo", "replies": replies, "debates": debates, "summary": replies["chair"], "final_action": "HOLD", "generatedAt": datetime.now(timezone.utc).isoformat()})
            if route == "/api/community":
                market = str(payload.get("market", "btcusdt")).lower()
                message = str(payload.get("message", "")).strip()
                name = str(payload.get("name", "Guest")).strip()[:30] or "Guest"
                if not message:
                    raise ValueError("Message is required.")
                item = {"id": str(len(COMMUNITY_MESSAGES.get(market, [])) + 1), "market": market.upper(), "name": name, "message": message[:500], "createdAt": datetime.now(timezone.utc).isoformat()}
                COMMUNITY_MESSAGES.setdefault(market, []).append(item)
                return self.json_response(HTTPStatus.CREATED, {"message": item})
            if route == "/api/ai-analysis":
                market = str(payload.get("market", "btcusdt")).upper()
                analysis = {"technical_analysis": f"[Demo mode] {market} local technical card.", "news_analysis": "[Demo mode] No external news is fetched in local testing.", "overall_summary": "[Demo mode] Educational simulation only.", "risk_level": "medium", "watchpoints": ["Check source data", "Watch volatility", "Use risk limits"]}
                return self.json_response(HTTPStatus.OK, {"mode": "demo", "market": market, "period": payload.get("period", 60), "indicators": {}, "news": [], "analysis": analysis, "generatedAt": datetime.now(timezone.utc).isoformat()})
            self.json_response(HTTPStatus.NOT_FOUND, {"error": "Endpoint not found."})
        except ValueError as error:
            self.json_response(HTTPStatus.BAD_REQUEST, {"error": str(error)})


if __name__ == "__main__":
    port = int(os.environ.get("LOCAL_DEMO_PORT", "8765"))
    server = ThreadingHTTPServer(("127.0.0.1", port), DemoHandler)
    print(f"Local demo: http://127.0.0.1:{port}")
    server.serve_forever()
