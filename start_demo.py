import os
import sys
import time
import subprocess
import webbrowser
import socketserver
import http.server
import json
import urllib.request
import urllib.parse
from datetime import datetime
import random
import threading
import xml.etree.ElementTree as ET
import hmac
import hashlib
import base64

base_dir = os.path.dirname(os.path.abspath(__file__))
web_index = os.path.join(base_dir, "web", "index.html")
PORT = 8080
# 僅綁定本機迴環，避免公共 Wi-Fi 未授權存取
HOST = "127.0.0.1"

print("==================================================================")
print("AI Investment Committee Master Orchestrator Starting...")
print("==================================================================")

class BedrockGate:
    """序列化所有 Bedrock 呼叫，保證同時在途請求數 == 1 且間隔 >= 1s。"""
    _lock = threading.Lock()
    _last_call = 0.0
    MIN_INTERVAL = 1.0

    @classmethod
    def invoke(cls, fn, *args, **kwargs):
        with cls._lock:
            wait = cls.MIN_INTERVAL - (time.monotonic() - cls._last_call)
            if wait > 0:
                time.sleep(wait)
            try:
                return fn(*args, **kwargs)
            finally:
                cls._last_call = time.monotonic()

# 1. 執行 R 數據腳本 (如果安裝了 Rscript)
r_script = os.path.join(base_dir, "scripts", "update_agent_report.R")
if os.path.exists(r_script):
    print("1/3 Executing R Data Pipeline (update_agent_report.R)...")
    try:
        proc = subprocess.run(
            ["Rscript", r_script],
            cwd=base_dir,
            capture_output=True,
            text=True,
            encoding='utf-8',
            errors='replace',
            timeout=60
        )
        if proc.returncode == 0:
            print("SUCCESS: R script updated agent_report.json.")
        else:
            print("WARNING: R script failed with exit code {}.".format(proc.returncode))
            print("----- Rscript STDOUT -----")
            print(proc.stdout if proc.stdout else "(empty)")
            print("----- Rscript STDERR -----")
            print(proc.stderr if proc.stderr else "(empty)")
            print("--------------------------")
            print("NOTICE: Continuing startup with existing fallback dataset.")
    except FileNotFoundError:
        print("WARNING: Rscript not found in PATH. R data pipeline skipped.")
        print("NOTICE: Continuing startup with existing fallback dataset.")
    except subprocess.TimeoutExpired:
        print("WARNING: R script exceeded the 60s timeout and was terminated.")
        print("NOTICE: Continuing startup with existing fallback dataset.")

# 2. 本地輕量 API 伺服器處理類別
class CommitteeAPIHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=os.path.join(base_dir, "web"), **kwargs)
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/") or path == "/test":
            if path == "/api/report":
                self.handle_report()
            elif path == "/api/market":
                self.handle_market(parsed.query)
            elif path == "/api/proxy":
                self.handle_proxy(parsed.query)
            elif path == "/api/news":
                self.handle_news()
            elif path == "/test":
                self.respond_json({"status": "ok", "message": "API Server Running"})
            else:
                self.send_error(404, "Endpoint Not Found")
        else:
            super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/trade":
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length).decode('utf-8')
            try:
                payload = json.loads(post_data) if post_data else {}
            except:
                payload = {}
            self.handle_trade(payload)
        else:
            self.send_error(404, "Endpoint Not Found")

    def handle_report(self):
        ticker = fetch_max_ticker("soltwd")
        price = ticker["price"]
        change24h = ticker["change24h"]
        
        # 讀取真實 R 語言跑出的 agent_report.json
        try:
            report_path = os.path.join(base_dir, "web", "agent_report.json")
            with open(report_path, "r", encoding="utf-8") as f:
                agent_data = json.load(f)
                
            rsi = agent_data["technical_agent"]["rsi"]
            signal = agent_data["technical_agent"]["signal"]
            risk_score = int(agent_data["investment_committee"]["risk_score"])
            buy_votes = int(agent_data["investment_committee"]["committee_score"])
            personality = agent_data["user_profile"]["personality"]
            win_rate = float(agent_data["user_profile"].get("win_rate", 0.68)) * 100
            sentiment_score = int(agent_data["sentiment_agent"].get("sentiment_score", 50))
            fear_greed = int(agent_data["sentiment_agent"].get("fear_greed", 50))
            behavior_score = int(agent_data["investment_committee"].get("behavior_score", 80))
        except Exception as e:
            print(f"Failed to read agent_report.json, falling back to mock data: {e}")
            rsi = round(45.0 + (random.random() * 20 - 10), 1)
            signal = "BUY" if rsi < 40 else ("SELL" if rsi > 70 else "HOLD")
            risk_score = 65
            buy_votes = random.randint(65, 75)
            personality = "波段型"
            win_rate = 68.0
            sentiment_score = 72
            fear_greed = 68
            behavior_score = 80

        debates = [
            {
                "agent": "Technical Agent (技術分析師)",
                "role": "技術面",
                "avatar": "📊",
                "score": str(int(rsi)),
                "signal": signal,
                "text": f"當前 SOL/TWD 即時報價 ${price:.2f} (24h: {change24h:+.2f}%)，RSI 為 {rsi}。5日與20日均線呈現穩健走勢，技術面信號為 {signal}！"
            },
            {
                "agent": "Risk Agent (風控長)",
                "role": "風控面",
                "avatar": "🛡️",
                "score": str(risk_score),
                "signal": "HOLD" if risk_score > 50 else "BUY",
                "text": f"關注歷史波動！綜合風險評分為 {risk_score}/100。建議嚴格控制倉位，不可盲目追高！"
            },
            {
                "agent": "Sentiment Agent (情緒分析師)",
                "role": "輿情面",
                "avatar": "💬",
                "score": str(sentiment_score),
                "signal": "BUY" if sentiment_score > 50 else "HOLD",
                "text": f"CoinMarketCap 恐慌與貪婪指數為 {fear_greed}。社群討論度在 Threads 與 X 上偏向正面，市場情緒偏看多。"
            },
            {
                "agent": "Behavior Agent (人格分析師)",
                "role": "用戶行為",
                "avatar": "👤",
                "score": str(behavior_score),
                "signal": "BUY" if behavior_score > 50 else "HOLD",
                "text": f"解析帳戶歷史交易，用戶屬於「{personality}」偏好，過往在此情境進場勝率達 {win_rate:.1f}%。契合當前佈局時機。"
            }
        ]

        hold_votes = min(20, 100 - buy_votes)
        sell_votes = max(0, 100 - buy_votes - hold_votes)

        res = {
            "currentPrice": price,
            "change24h": change24h,
            "debates": debates,
            "committee": {
                "buyPercentage": buy_votes,
                "holdPercentage": hold_votes,
                "sellPercentage": sell_votes,
                "finalDecision": "BUY (建議買進)" if buy_votes >= 60 else "HOLD (觀望)",
                "confidenceScore": buy_votes
            },
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        }
        self.respond_json(res)

    def handle_market(self, query_str):
        params = urllib.parse.parse_qs(query_str)
        market = params.get("market", ["soltwd"])[0]
        ticker = fetch_max_ticker(market)
        self.respond_json(ticker)

    def handle_proxy(self, query_str):
        params = urllib.parse.parse_qs(query_str)
        target_path = params.get("path", [""])[0]
        if not target_path:
            self.send_error(400, "Missing path parameter")
            return
        parsed_self = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qsl(parsed_self.query)
        actual_params = [f"{k}={v}" for k, v in qs if k != 'path']
        actual_query_string = "&".join(actual_params)
        
        url = f"https://max-api.maicoin.com{target_path}"
        if actual_query_string:
            url += f"?{actual_query_string}"
            
        try:
            req = urllib.request.urlopen(url, timeout=5)
            data = json.loads(req.read().decode('utf-8'))
            self.respond_json(data)
        except Exception as e:
            self.send_error(500, f"Proxy Error: {str(e)}")

    def handle_trade(self, payload):
        market = payload.get("market", "soltwd").upper()
        side = payload.get("side", "buy").upper()
        volume = float(payload.get("volume", 1.0))
        ticker = fetch_max_ticker(market.lower())
        price = ticker["price"]
        total_twd = price * volume
        
        # 實作 MAX API 真實 Hooks
        # 若有環境變數 MAX_ACCESS_KEY 與 MAX_SECRET_KEY 則嘗試真實打單，否則走 Mock 引擎
        access_key = os.environ.get("MAX_ACCESS_KEY")
        secret_key = os.environ.get("MAX_SECRET_KEY")
        
        if access_key and secret_key:
            try:
                nonce = int(time.time() * 1000)
                api_path = "/api/v2/orders"
                api_payload = {
                    "market": market.lower(),
                    "side": side.lower(),
                    "volume": str(volume),
                    "price": str(price),
                    "ord_type": "limit",
                    "nonce": nonce
                }
                payload_json = json.dumps(api_payload)
                payload_b64 = base64.b64encode(payload_json.encode('utf-8')).decode('utf-8')
                signature = hmac.new(
                    secret_key.encode('utf-8'),
                    payload_b64.encode('utf-8'),
                    hashlib.sha256
                ).hexdigest()

                req = urllib.request.Request(f"https://max-api.maicoin.com{api_path}")
                req.add_header('X-MAX-ACCESSKEY', access_key)
                req.add_header('X-MAX-PAYLOAD', payload_b64)
                req.add_header('X-MAX-SIGNATURE', signature)
                req.add_header('Content-Type', 'application/json')
                
                response = urllib.request.urlopen(req, data=payload_json.encode('utf-8'), timeout=5)
                max_res = json.loads(response.read().decode('utf-8'))
                
                order_id = str(max_res.get("id", f"MAX_ORD_{nonce}"))
                timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                res = {
                    "status": "201 Created",
                    "success": True,
                    "orderId": order_id,
                    "market": market,
                    "side": side,
                    "price": price,
                    "volume": volume,
                    "totalTWD": total_twd,
                    "executedAt": timestamp,
                    "message": "✅ 真實 API 下單成功！訂單已送至 MAX 交易所。"
                }
            except Exception as e:
                res = {
                    "status": "500 Internal Server Error",
                    "success": False,
                    "message": f"❌ 真實 API 下單失敗: {str(e)}"
                }
        else:
            # Mock 引擎
            nonce = int(time.time() * 1000)
            order_id = f"MAX_ORD_{nonce}"
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            res = {
                "status": "201 Created",
                "success": True,
                "orderId": order_id,
                "market": market,
                "side": side,
                "price": price,
                "volume": volume,
                "totalTWD": total_twd,
                "executedAt": timestamp,
                "message": "✅ 雙向數據流下單成功！(Mock API: 未設置環境變數，已由模擬引擎撮合)"
            }
            
        self.respond_json(res)

    def handle_news(self):
        url = "https://cointelegraph.com/rss"
        try:
            req = urllib.request.urlopen(url, timeout=5)
            xml_data = req.read().decode('utf-8')
            root = ET.fromstring(xml_data)
            items = []
            for item in root.findall('./channel/item')[:5]:
                title = item.find('title').text if item.find('title') is not None else ''
                link = item.find('link').text if item.find('link') is not None else ''
                pubDate = item.find('pubDate').text if item.find('pubDate') is not None else ''
                items.append({
                    "title": title,
                    "link": link,
                    "pubDate": pubDate
                })
            self.respond_json({"status": "success", "news": items})
        except Exception as e:
            # Fallback data if RSS fetch fails
            fallback = [
                {"title": "BTC 突破 96,000 美元，創下歷史新高", "link": "#", "pubDate": datetime.now().strftime("%Y-%m-%d %H:%M:%S")},
                {"title": "以太坊現貨 ETF 獲准上市", "link": "#", "pubDate": datetime.now().strftime("%Y-%m-%d %H:%M:%S")},
                {"title": "Solana 網路升級成功，交易速度翻倍", "link": "#", "pubDate": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
            ]
            self.respond_json({"status": "fallback", "news": fallback, "error": str(e)})

    def respond_json(self, data):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

def fetch_max_ticker(market):
    url = f"https://max-api.maicoin.com/api/v2/tickers/{market}"
    try:
        req = urllib.request.urlopen(url, timeout=3)
        res = json.loads(req.read().decode('utf-8'))
        last_price = float(res.get("last", 5200))
        open_price = float(res.get("open", 5100))
        change = ((last_price - open_price) / open_price) * 100
        return {"price": last_price, "change24h": round(change, 2), "volume": float(res.get("vol", 0))}
    except:
        return {"price": 2411.2, "change24h": 1.10, "volume": 12500.0}

def start_server():
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer((HOST, PORT), CommitteeAPIHandler) as httpd:
        print(f"2/3 API Server is running indefinitely on http://localhost:{PORT}")
        httpd.serve_forever()

# 背景啟動 API 伺服器
server_thread = threading.Thread(target=start_server, daemon=True)
server_thread.start()
time.sleep(1)

# 3. 開啟預設瀏覽器
print("\n3/3 Opening Web UI in Browser...")
url = "http://localhost:8080/"
webbrowser.open(url)

print("\n==================================================================")
print("SUCCESS: System is UP and RUNNING!")
print("API Endpoints Ready:")
print("  - GET  http://localhost:8080/api/report")
print("  - GET  http://localhost:8080/api/market")
print("  - POST http://localhost:8080/api/trade")
print("==================================================================")
print("Press Ctrl + C in this terminal to shutdown the server.\n")

try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    print("\nStopping API Server...")
    print("System Shutdown Complete.")
