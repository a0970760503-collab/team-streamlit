"""Read-only Lambda API for the AI Investment Committee web app.

This handler intentionally has no trading endpoint. Its MAX proxy accepts only
the few public market-data paths used by the frontend.
"""

import base64
import json
import os
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import BotoCoreError, ClientError

MAX_API_URL = "https://max-api.maicoin.com"
RSS_URL = "https://cointelegraph.com/rss"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
MARKET_PATTERN = re.compile(r"^[a-z0-9]{3,16}$")
VALID_PERIODS = {1, 5, 15, 60, 240, 1440, 10080}
SECRET_CACHE = None


def json_response(status_code, body):
    return {"statusCode": status_code, "headers": {
        "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
        "access-control-allow-origin": os.environ.get("ALLOWED_ORIGIN", "*")},
        "body": json.dumps(body, ensure_ascii=False)}


def validate_market(value):
    market = str(value or "").lower().strip()
    if not MARKET_PATTERN.fullmatch(market):
        raise ValueError("Invalid market symbol.")
    return market


def community_table():
    table_name = os.environ.get("COMMUNITY_TABLE", "").strip()
    if not table_name:
        raise RuntimeError("Community discussion is not configured.")
    return boto3.resource("dynamodb").Table(table_name)


def list_community_messages(market):
    market = validate_market(market)
    response = community_table().query(
        KeyConditionExpression=Key("Market").eq(market),
        ScanIndexForward=False,
        Limit=60,
    )
    items = list(reversed(response.get("Items", [])))
    return [{
        "id": str(item.get("Id", "")), "market": str(item.get("Market", "")).upper(),
        "name": str(item.get("Name", "訪客")), "message": str(item.get("Message", "")),
        "createdAt": str(item.get("CreatedAt", "")),
    } for item in items]


def post_community_message(payload):
    if not isinstance(payload, dict):
        raise ValueError("Request body must be a JSON object.")
    market = validate_market(payload.get("market", "btcusdt"))
    name = re.sub(r"\s+", " ", str(payload.get("name", "訪客")).strip())[:30]
    message = str(payload.get("message", "")).strip()
    if not (1 <= len(name) <= 30):
        raise ValueError("Display name must be 1 to 30 characters.")
    if not (1 <= len(message) <= 500):
        raise ValueError("Discussion message must be 1 to 500 characters.")

    created_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds") + "#" + uuid.uuid4().hex[:8]
    item = {
        "Market": market, "CreatedAt": created_at, "Id": uuid.uuid4().hex,
        "Name": name, "Message": message,
        "ExpiresAt": int((datetime.now(timezone.utc) + timedelta(days=7)).timestamp()),
    }
    community_table().put_item(Item=item)
    return {"id": item["Id"], "market": market.upper(), "name": name, "message": message, "createdAt": created_at}


def http_get_json(url, timeout=10):
    request = urllib.request.Request(url, headers={"User-Agent": "AI-Investment-Committee/1.0"})
    with urllib.request.urlopen(request, timeout=timeout) as remote_response:
        return json.loads(remote_response.read().decode("utf-8"))


def fetch_ticker(market):
    market = validate_market(market)
    try:
        payload = http_get_json(f"{MAX_API_URL}/api/v2/tickers/{market}", timeout=5)
        price, open_price = float(payload["last"]), float(payload["open"])
        if open_price == 0:
            raise ValueError("Ticker open price is zero.")
        return {"price": price, "change24h": round((price - open_price) / open_price * 100, 2),
                "volume": float(payload.get("vol", 0) or 0), "dataSource": "live"}
    except (urllib.error.HTTPError, urllib.error.URLError, socket.timeout, TimeoutError,
            json.JSONDecodeError, KeyError, TypeError, ValueError, OSError) as exc:
        return {"price": None, "change24h": None, "volume": None, "dataSource": "unavailable",
                "error": f"{type(exc).__name__}: {exc}"}


def handle_report():
    with open(os.path.join(os.path.dirname(__file__), "agent_report.json"), encoding="utf-8") as report_file:
        report = json.load(report_file)
    ticker, committee = fetch_ticker("soltwd"), report.get("investment_committee", {})
    technical, sentiment, user = (report.get("technical_agent", {}), report.get("sentiment_agent", {}),
                                  report.get("user_profile", {}))
    score = max(0, min(100, int(committee.get("committee_score", 50))))
    hold = min(20, 100 - score)
    return {"currentPrice": ticker["price"], "change24h": ticker["change24h"], "dataSource": ticker["dataSource"],
            "priceError": ticker.get("error"), "debates": [
                {"agent": "Technical Agent", "role": "技術分析", "avatar": "📈", "score": str(technical.get("rsi", "-")),
                 "signal": technical.get("signal", "HOLD"), "text": "技術指標以目前市場資料與既有研究報告彙整。"},
                {"agent": "Risk Agent", "role": "風險管理", "avatar": "🛡️", "score": str(committee.get("risk_score", "-")),
                 "signal": "HOLD", "text": "所有市場資料僅供研究，請自行評估承受風險。"},
                {"agent": "Sentiment Agent", "role": "市場情緒", "avatar": "📰", "score": str(sentiment.get("sentiment_score", "-")),
                 "signal": "HOLD", "text": "新聞與情緒資料可能延遲或不完整。"},
                {"agent": "Behavior Agent", "role": "行為輪廓", "avatar": "🧭", "score": str(committee.get("behavior_score", "-")),
                 "signal": "HOLD", "text": f"風險輪廓：{user.get('personality', '未設定')}。"}],
            "committee": {"buyPercentage": score, "holdPercentage": hold, "sellPercentage": max(0, 100 - score - hold),
                          "finalDecision": "HOLD（研究用途）", "confidenceScore": score},
            "timestamp": datetime.now(timezone.utc).isoformat()}


def fetch_proxy(params):
    path, market = str(params.get("path") or ""), validate_market(params.get("market", "soltwd"))
    try:
        limit = max(1, min(500, int(params.get("limit", "35"))))
    except ValueError as exc:
        raise ValueError("Invalid limit.") from exc
    if path == "/api/v2/tickers":
        return http_get_json(f"{MAX_API_URL}{path}", timeout=8)
    if re.fullmatch(r"/api/v2/tickers/[a-z0-9]{3,16}", path):
        return http_get_json(f"{MAX_API_URL}{path}", timeout=8)
    if path == "/api/v2/depth":
        return http_get_json(f"{MAX_API_URL}{path}?" + urllib.parse.urlencode({"market": market, "limit": limit}), timeout=8)
    if path == "/api/v2/k":
        try:
            period = int(params.get("period", "60"))
        except ValueError as exc:
            raise ValueError("Invalid candle period.") from exc
        if period not in VALID_PERIODS:
            raise ValueError("Unsupported candle period.")
        return http_get_json(f"{MAX_API_URL}{path}?" + urllib.parse.urlencode({"market": market, "limit": limit, "period": period}), timeout=8)
    raise ValueError("Unsupported proxy path.")


def decision_backtest(market, action):
    market, action = validate_market(market), str(action or "HOLD").upper()
    if action not in {"BUY", "SELL", "HOLD"}:
        raise ValueError("Unsupported decision.")
    raw = fetch_proxy({"path": "/api/v2/k", "market": market, "period": 60, "limit": 72})
    candles = [row for row in raw if isinstance(row, list) and len(row) >= 5]
    if len(candles) < 2:
        raise ValueError("Not enough historical candles.")
    closes = [float(row[4]) for row in candles]
    entry, exit_price = closes[0], closes[-1]
    benchmark = (exit_price / entry - 1) * 100
    equity, changes = [1.0], []
    for previous, current in zip(closes, closes[1:]):
        move = current / previous - 1
        changes.append(move)
        equity.append(equity[-1] * (1 if action == "HOLD" else (1 + move if action == "BUY" else 1 - move)))
    peak, max_drawdown = equity[0], 0.0
    for value in equity:
        peak = max(peak, value)
        max_drawdown = min(max_drawdown, (value / peak - 1) * 100)
    win_rate = (sum(move > 0 for move in changes) if action == "BUY" else sum(move < 0 for move in changes) if action == "SELL" else sum(abs(move) < 0.003 for move in changes)) / len(changes) * 100
    return {"market": market.upper(), "action": action, "periodMinutes": 60, "candles": len(candles), "entryPrice": entry, "exitPrice": exit_price,
            "strategyReturnPct": round((equity[-1] - 1) * 100, 2), "benchmarkReturnPct": round(benchmark, 2), "maxDrawdownPct": round(max_drawdown, 2), "hitRatePct": round(win_rate, 1), "dataSource": "live",
            "disclaimer": "教育用歷史模擬：將目前決策套用於最近 72 根 1 小時 K 線；不含手續費、滑價，且不代表未來表現。"}


def fetch_news(market=""):
    base = str(market).lower().replace("usdt", "").replace("twd", "")
    if base and not MARKET_PATTERN.fullmatch(base):
        raise ValueError("Invalid market symbol.")
    tag = {"btc": "bitcoin", "eth": "ethereum", "sol": "solana", "doge": "dogecoin"}.get(base, base)
    url = RSS_URL if not tag else f"{RSS_URL}/tag/{urllib.parse.quote(tag)}"
    request = urllib.request.Request(url, headers={"User-Agent": "AI-Investment-Committee/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=10) as remote_response:
            root = ET.fromstring(remote_response.read().decode("utf-8"))
        cutoff, articles = datetime.now(timezone.utc) - timedelta(days=7), []
        for item in root.findall("./channel/item"):
            title, link, published = item.findtext("title", default="").strip(), item.findtext("link", default="").strip(), item.findtext("pubDate", default="").strip()
            try:
                published_at = parsedate_to_datetime(published)
                if published_at.tzinfo is None:
                    published_at = published_at.replace(tzinfo=timezone.utc)
            except (TypeError, ValueError, IndexError):
                continue
            if title and published_at >= cutoff:
                articles.append({"title": title, "link": link, "pubDate": published})
            if len(articles) == 10:
                break
        return articles
    except (urllib.error.HTTPError, urllib.error.URLError, socket.timeout, TimeoutError, ET.ParseError, OSError):
        return []


def ema_series(values, period):
    value, result, multiplier = sum(values[:period]) / period, [None] * (period - 1), 2 / (period + 1)
    result.append(value)
    for item in values[period:]:
        value = (item - value) * multiplier + value
        result.append(value)
    return result


def calculate_indicators(candles):
    closes = [item[4] for item in candles]
    if len(closes) < 50:
        raise ValueError("Not enough candle data to calculate technical indicators.")
    ema12, ema26 = ema_series(closes, 12), ema_series(closes, 26)
    macd_values = [ema12[index] - ema26[index] for index in range(25, len(closes))]
    signal_values = ema_series(macd_values, 9)
    gains, losses = [], []
    for index in range(1, 15):
        change = closes[index] - closes[index - 1]
        gains.append(max(change, 0)); losses.append(abs(min(change, 0)))
    average_gain, average_loss = sum(gains) / 14, sum(losses) / 14
    for index in range(15, len(closes)):
        change = closes[index] - closes[index - 1]
        average_gain = (average_gain * 13 + max(change, 0)) / 14
        average_loss = (average_loss * 13 + abs(min(change, 0))) / 14
    latest_rsi = 100.0 if average_loss == 0 else 100 - (100 / (1 + average_gain / average_loss))
    sma20, sma50, latest_macd, latest_signal = sum(closes[-20:]) / 20, sum(closes[-50:]) / 50, macd_values[-1], signal_values[-1]
    score = (1 if closes[-1] > sma20 else -1) + (1 if sma20 > sma50 else -1) + (1 if 50 <= latest_rsi <= 70 else (-1 if latest_rsi > 70 else 0)) + (1 if latest_macd > latest_signal else -1)
    return {"close": round(closes[-1], 8), "sma20": round(sma20, 8), "sma50": round(sma50, 8), "rsi14": round(latest_rsi, 2),
            "macd": round(latest_macd, 8), "macdSignal": round(latest_signal, 8),
            "trendBias": "bullish" if score >= 2 else ("bearish" if score <= -2 else "neutral"), "indicatorScore": score, "candleCount": len(candles)}


def anthropic_key():
    global SECRET_CACHE
    if SECRET_CACHE is None:
        secret_arn = os.environ.get("ANTHROPIC_SECRET_ARN", "").strip()
        if not secret_arn:
            raise RuntimeError("AI analysis has not been configured.")
        value = boto3.client("secretsmanager").get_secret_value(SecretId=secret_arn).get("SecretString", "")
        try:
            value = json.loads(value).get("ANTHROPIC_API_KEY", "")
        except json.JSONDecodeError:
            pass
        SECRET_CACHE = str(value).strip()
    if not SECRET_CACHE:
        raise RuntimeError("The Anthropic API key is missing from the configured secret.")
    return SECRET_CACHE


def demo_mode_enabled():
    return os.environ.get("DEMO_MODE", "false").strip().lower() in {"1", "true", "yes", "on"}


def request_bedrock_json(system, prompt, max_tokens, temperature):
    try:
        response = boto3.client("bedrock-runtime").converse(
            modelId=os.environ.get("BEDROCK_MODEL", "amazon.nova-2-lite-v1:0"),
            system=[{"text": system}], messages=[{"role": "user", "content": [{"text": json.dumps(prompt, ensure_ascii=False)}]}],
            inferenceConfig={"maxTokens": max_tokens, "temperature": temperature},
        )
        text = "".join(item.get("text", "") for item in response["output"]["message"]["content"])
        value = json.loads(text.removeprefix("```json").removeprefix("```").removesuffix("```").strip())
    except (BotoCoreError, ClientError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        # Keep diagnostics free of request content and secrets while preserving
        # the AWS error needed to investigate model access or IAM problems.
        print(f"BedrockConverseFailed type={type(exc).__name__} message={exc}")
        raise RuntimeError("Amazon Bedrock request failed; review the Lambda CloudWatch log for the error type.") from exc
    if not isinstance(value, dict):
        raise RuntimeError("Amazon Bedrock returned an invalid format.")
    return value


def request_analysis(market, period, technical, news):
    prompt = {"asset": market.upper(), "candle_period_minutes": period, "technical_indicators": technical, "news_last_7_days": news,
              "output_contract": {"technical_analysis": "Traditional Chinese, 120-180 words", "news_analysis": "Traditional Chinese, 100-150 words", "overall_summary": "Traditional Chinese, research only; no buy/sell instruction", "risk_level": "low, medium, or high", "watchpoints": ["Traditional Chinese item", "Traditional Chinese item", "Traditional Chinese item"]}}
    result = request_bedrock_json("Use only supplied JSON. Return valid JSON only. Do not give trading instructions or guarantee outcomes.", prompt, 1100, 0.2)
    return {"technical_analysis": str(result.get("technical_analysis", ""))[:1800], "news_analysis": str(result.get("news_analysis", ""))[:1600], "overall_summary": str(result.get("overall_summary", ""))[:1400], "risk_level": str(result.get("risk_level", "medium"))[:20], "watchpoints": [str(item)[:240] for item in result.get("watchpoints", [])[:5]]}


def request_debate_reply(market, user_message):
    market_data = fetch_ticker(market)
    prompt = {
        "market": market.upper(), "market_data": market_data, "user_message": user_message,
        "output_contract": {
            "technical": "Traditional Chinese, 50-90 words; directly discuss the user's point using available market data only.",
            "risk": "Traditional Chinese, 50-90 words; state uncertainty and risk controls without trade instructions.",
            "chair": "Traditional Chinese, 60-110 words; fairly synthesise the user and agents, research only, no buy/sell instruction."
        }
    }
    result = request_bedrock_json("You are a careful investment research committee. Treat the user as a participant. Use only supplied JSON, return valid JSON only, and do not give personalized financial advice, trading instructions, or guarantees.", prompt, 700, 0.3)
    return {"technical": str(result.get("technical", ""))[:1200], "risk": str(result.get("risk", ""))[:1200], "chair": str(result.get("chair", ""))[:1400]}


def demo_debate_reply(market, user_message):
    """Safe, deterministic fallback for classroom demonstrations without an AI credit balance."""
    ticker = fetch_ticker(market)
    if ticker.get("dataSource") == "live" and ticker.get("price") is not None:
        market_context = f"The public quote is {ticker['price']:,} with a 24-hour change of {ticker.get('change24h', 0):+.2f}%"
    else:
        market_context = "A verified live quote is unavailable, so no price conclusion is made"
    topic = re.sub(r"\s+", " ", user_message).strip()[:160]
    return {
        "technical": f"[Demo mode] {market.upper()}: {market_context}. The technical agent treats the user's topic as a research question and would wait for a confirmed trend, volume, and risk limit before drawing conclusions.",
        "risk": f"[Demo mode] Risk agent response to “{topic}”: market data can move quickly and this simulation does not provide investment instructions. Consider uncertainty, position size, and a predefined stop condition.",
        "chair": f"[Demo mode] The committee recorded the participant's point: “{topic}”. Based on the available information, the demonstration conclusion is HOLD / continue observing. This is an educational simulation, not a trading recommendation.",
    }


def demo_analysis(market, period, technical, news):
    """Return a clearly labelled analysis card when the external AI provider is unavailable."""
    trend = str(technical.get("trendBias", "neutral"))
    rsi = technical.get("rsi14", "-")
    headline = news[0].get("title", "No recent verified headline is available") if news else "No recent verified headline is available"
    return {
        "technical_analysis": f"[Demo mode] {market.upper()} uses a {period}-minute chart. The calculated trend bias is {trend} and RSI is {rsi}. This card is generated locally for demonstration and is not an AI prediction.",
        "news_analysis": f"[Demo mode] Latest available headline: {headline}. Headlines can be incomplete or delayed; verify the original source before making any decision.",
        "overall_summary": "[Demo mode] Continue observing and use predefined risk controls. This educational simulation does not provide buy, sell, or personalised investment advice.",
        "risk_level": "medium",
        "watchpoints": ["Confirm market-data source status", "Watch volatility and liquidity", "Do not treat this demo as investment advice"],
    }


def lambda_handler(event, _context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    path, params = event.get("rawPath") or event.get("path", ""), event.get("queryStringParameters") or {}
    try:
        if method == "GET" and path == "/api/report": return json_response(200, handle_report())
        if method == "GET" and path == "/api/market": return json_response(200, fetch_ticker(params.get("market", "soltwd")))
        if method == "GET" and path == "/api/backtest": return json_response(200, decision_backtest(params.get("market", "btcusdt"), params.get("action", "HOLD")))
        if method == "GET" and path == "/api/proxy": return json_response(200, fetch_proxy(params))
        if method == "GET" and path == "/api/news": return json_response(200, {"status": "success", "news": fetch_news(params.get("market", ""))})
        if method == "GET" and path == "/api/community":
            return json_response(200, {"messages": list_community_messages(params.get("market", "btcusdt"))})
        if method == "POST" and path == "/api/community":
            raw_body = event.get("body") or "{}"
            if event.get("isBase64Encoded"): raw_body = base64.b64decode(raw_body).decode("utf-8")
            return json_response(201, {"message": post_community_message(json.loads(raw_body))})
        if method == "POST" and path == "/api/ai-analysis":
            raw_body = event.get("body") or "{}"
            if event.get("isBase64Encoded"): raw_body = base64.b64decode(raw_body).decode("utf-8")
            payload, market = json.loads(raw_body), None
            if not isinstance(payload, dict): raise ValueError("Request body must be a JSON object.")
            market, period = validate_market(payload.get("market", "btcusdt")), int(payload.get("period", 60))
            if period not in VALID_PERIODS: raise ValueError("Unsupported candle period.")
            raw_candles = fetch_proxy({"path": "/api/v2/k", "market": market, "period": period, "limit": 120})
            candles = [[float(item[index]) for index in range(6)] for item in raw_candles if isinstance(item, list) and len(item) >= 6]
            technical, news = calculate_indicators(candles), fetch_news(market)
            if demo_mode_enabled():
                analysis, mode = demo_analysis(market, period, technical, news), "demo"
            else:
                try:
                    analysis, mode = request_analysis(market, period, technical, news), "ai"
                except RuntimeError:
                    analysis, mode = demo_analysis(market, period, technical, news), "demo"
            return json_response(200, {"market": market.upper(), "period": period, "indicators": technical, "news": news, "analysis": analysis, "mode": mode, "generatedAt": datetime.now(timezone.utc).isoformat()})
        if method == "POST" and path == "/api/debate-message":
            raw_body = event.get("body") or "{}"
            if event.get("isBase64Encoded"): raw_body = base64.b64decode(raw_body).decode("utf-8")
            payload = json.loads(raw_body)
            if not isinstance(payload, dict): raise ValueError("Request body must be a JSON object.")
            market = validate_market(payload.get("market", "btcusdt"))
            message = str(payload.get("message", "")).strip()
            if not (1 <= len(message) <= 700): raise ValueError("Discussion message must be 1 to 700 characters.")
            if demo_mode_enabled():
                replies, mode = demo_debate_reply(market, message), "demo"
            else:
                try:
                    replies, mode = request_debate_reply(market, message), "ai"
                except RuntimeError:
                    replies, mode = demo_debate_reply(market, message), "demo"
            # Keep the concise API used by the serverless UI and also provide the
            # debate schema expected by the latest repository interface.
            debates = [
                {"agent": "tech", "icon": "📈", "name": "技術 Agent", "color": "var(--primary)", "text": replies.get("technical", "")},
                {"agent": "risk", "icon": "🛡️", "name": "風險 Agent", "color": "var(--warning)", "text": replies.get("risk", "")},
                {"agent": "chair", "icon": "👑", "name": "主席 Agent", "color": "#ffd700", "text": replies.get("chair", "")},
            ]
            return json_response(200, {
                "replies": replies, "debates": debates,
                "summary": replies.get("chair", ""), "final_action": "HOLD", "mode": mode,
                "generatedAt": datetime.now(timezone.utc).isoformat(),
            })
        return json_response(404, {"error": "Endpoint not found."})
    except ValueError as exc:
        return json_response(400, {"error": str(exc)})
    except RuntimeError as exc:
        return json_response(503, {"error": str(exc)})
    except Exception:
        return json_response(502, {"error": "The service is temporarily unavailable. Please try again."})
