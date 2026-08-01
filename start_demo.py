import os
import sys
import time
import subprocess
import threading
import socketserver
import os
import sys

# Force UTF-8 encoding for stdout on Windows to prevent cp950 crashes
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

# ---------------------------------------------------------
import socket
import webbrowser
import http.server
import json
import socket
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime
import random
import threading
import xml.etree.ElementTree as ET
import hmac
import hashlib
import base64

from dotenv import load_dotenv
import boto3

load_dotenv()
try:
    bedrock_client = boto3.client('bedrock-runtime', region_name=os.environ.get('AWS_DEFAULT_REGION', 'us-west-2'))
except Exception as e:
    print(f"Warning: Failed to initialize Bedrock client: {e}")
    bedrock_client = None

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
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

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
                self.handle_news(parsed.query)
            elif path == "/test":
                self.respond_json({"status": "ok", "message": "API Server Running"})
            else:
                self.respond_json({"error": "Endpoint Not Found"}, status=404)
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
        elif parsed.path == "/api/chat_assistant":
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length).decode('utf-8')
            try:
                payload = json.loads(post_data) if post_data else {}
            except:
                payload = {}
            self.handle_chat_assistant(payload)
        elif parsed.path == "/api/chat_debate":
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length).decode('utf-8')
            try:
                payload = json.loads(post_data) if post_data else {}
            except:
                payload = {}
            self.handle_chat_debate(payload)
        elif parsed.path == "/api/conclude_debate":
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length).decode('utf-8')
            try:
                payload = json.loads(post_data) if post_data else {}
            except:
                payload = {}
            self.handle_conclude_debate(payload)
        elif parsed.path == "/api/extract_topic":
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length).decode('utf-8')
            try:
                payload = json.loads(post_data) if post_data else {}
            except:
                payload = {}
            self.handle_extract_topic(payload)
        else:
            self.respond_json({"error": "Endpoint Not Found"}, status=404)

    def handle_report(self):
        ticker = fetch_max_ticker("soltwd")
        price = ticker["price"]
        change24h = ticker["change24h"]
        data_source = ticker.get("dataSource", "unavailable")
        price_available = data_source == "live" and price is not None and change24h is not None
        
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
            risk_score = 65
            personality = "波段型"
            win_rate = 68.0
            sentiment_score = 72
            fear_greed = 68
            behavior_score = 80

        if price_available:
            price_phrase = f"當前即時報價 ${price:.2f} (24h: {change24h:+.2f}%)"
        else:
            price_phrase = "即時報價暫時無法取得"

        def invoke_claude(role_prompt, data_context):
            if not getattr(sys.modules[__name__], 'bedrock_client', None):
                return {"text": "Bedrock 客戶端尚未初始化", "signal": "HOLD"}
            
            prompt = f"Human: 你現在是 AI 投資委員會的「{role_prompt}」。\n請根據以下數據進行 40 字以內的極簡分析，並在最後一行獨立輸出你的決策(只能是 BUY, HOLD, 或 SELL 其中一個單字)：\n{data_context}\n\nAssistant:"
            body = json.dumps({
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 150,
                "temperature": 0.5,
                "messages": [
                    {
                        "role": "user",
                        "content": [{"type": "text", "text": prompt}]
                    }
                ]
            })
            
            def _do_invoke():
                response = bedrock_client.invoke_model(
                    modelId='anthropic.claude-haiku-4-5-20251001-v1:0',
                    body=body
                )
                response_body = json.loads(response.get('body').read())
                return response_body.get('content')[0]['text']

            try:
                result_text = BedrockGate.invoke(_do_invoke)
                lines = result_text.strip().split('\n')
                decision = "HOLD"
                for d in ["BUY", "SELL", "HOLD"]:
                    if d in lines[-1].upper():
                        decision = d
                        break
                display_text = "\n".join(lines[:-1]).strip() if len(lines) > 1 else result_text
                if not display_text:  # Fallback if Claude only returns the decision word
                    display_text = f"({role_prompt} 選擇了 {decision})"
                return {"text": display_text, "signal": decision}
            except Exception as e:
                print(f"Bedrock Error ({role_prompt}): {e}")
                return {"text": f"API 呼叫失敗 ({e})", "signal": "HOLD"}

        tech_res = invoke_claude("技術分析師", f"市場: {price_phrase}\nRSI指標: {rsi}")
        risk_res = invoke_claude("風控長", f"市場: {price_phrase}\n風險評分: {risk_score}/100")
        sent_res = invoke_claude("情緒分析師", f"市場: {price_phrase}\n社群討論分數: {sentiment_score}\n恐慌貪婪指數: {fear_greed}")
        beh_res = invoke_claude("行為分析師", f"用戶性格: {personality}\n歷史勝率: {win_rate:.1f}%\n行為評分: {behavior_score}/100")

        debates = [
            {
                "agent": "Technical Agent (技術分析師)",
                "role": "技術面",
                "avatar": "📊",
                "score": str(int(rsi)),
                "signal": tech_res["signal"],
                "text": tech_res["text"]
            },
            {
                "agent": "Risk Agent (風控長)",
                "role": "風控面",
                "avatar": "🛡️",
                "score": str(risk_score),
                "signal": risk_res["signal"],
                "text": risk_res["text"]
            },
            {
                "agent": "Sentiment Agent (情緒分析師)",
                "role": "輿情面",
                "avatar": "💬",
                "score": "68",
                "signal": sent_res["signal"],
                "text": sent_res["text"]
            },
            {
                "agent": "Behavior Agent (人格分析師)",
                "role": "用戶行為",
                "avatar": "👤",
                "score": "80",
                "signal": beh_res["signal"],
                "text": beh_res["text"]
            }
        ]

        buy_votes = sum(1 for d in debates if d["signal"] == "BUY") * 25
        sell_votes = sum(1 for d in debates if d["signal"] == "SELL") * 25
        hold_votes = 100 - buy_votes - sell_votes
        
        if buy_votes > sell_votes and buy_votes > hold_votes:
            final_decision = "BUY (建議買進)"
        elif sell_votes > buy_votes and sell_votes > hold_votes:
            final_decision = "SELL (建議賣出)"
        else:
            final_decision = "HOLD (觀望)"

        res = {
            "currentPrice": price if price_available else None,
            "change24h": change24h if price_available else None,
            "dataSource": data_source,
            "priceError": ticker.get("error"),
            "debates": debates,
            "committee": {
                "buyPercentage": buy_votes,
                "holdPercentage": hold_votes,
                "sellPercentage": sell_votes,
                "finalDecision": final_decision,
                "confidenceScore": max(buy_votes, sell_votes, hold_votes)
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
            self.respond_json({"error": "Missing path parameter"}, status=400)
            return
        parsed_self = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qsl(parsed_self.query)
        actual_params = [f"{k}={v}" for k, v in qs if k != 'path']
        actual_query_string = "&".join(actual_params)
        
        url = f"https://max-api.maicoin.com{target_path}"
        if actual_query_string:
            url += f"?{actual_query_string}"
            
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
            res_req = urllib.request.urlopen(req, timeout=5)
            data = json.loads(res_req.read().decode('utf-8'))
            self.respond_json(data)
        except Exception as e:
            self.respond_json({"error": f"Proxy Error: {str(e)}"}, status=500)

    def handle_trade(self, payload):
        market = payload.get("market", "soltwd").upper()
        side = payload.get("side", "buy").upper()
        volume = float(payload.get("volume", 1.0))
        ticker = fetch_max_ticker(market.lower())
        price = ticker["price"]
        if ticker.get("dataSource") != "live" or price is None:
            # P10：報價不可用時不得以假價成交，直接中止委託並明示原因
            self.respond_json({
                "status": "503 Service Unavailable",
                "success": False,
                "dataSource": "unavailable",
                "market": market,
                "side": side,
                "volume": volume,
                "message": "❌ 無法取得即時報價，為避免以非即時價格成交，已中止此次委託。",
                "error": ticker.get("error")
            })
            return
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

    def handle_news(self, query_str=""):
        params = urllib.parse.parse_qs(query_str)
        market_query = params.get("market", [""])[0].lower()
        
        url = "https://cointelegraph.com/rss"
        if market_query:
            if market_query == "btc":
                url = "https://cointelegraph.com/rss/tag/bitcoin"
            elif market_query == "eth":
                url = "https://cointelegraph.com/rss/tag/ethereum"
            elif market_query == "sol":
                url = "https://cointelegraph.com/rss/tag/solana"
            elif market_query == "doge":
                url = "https://cointelegraph.com/rss/tag/dogecoin"
            else:
                url = f"https://cointelegraph.com/rss/tag/{market_query}"
                
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
            res_req = urllib.request.urlopen(req, timeout=5)
            xml_data = res_req.read().decode('utf-8')
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
            # RSS fetch fails
            self.respond_json({"status": "error", "news": [], "error": str(e)})

    def respond_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

    def handle_chat_assistant(self, payload):
        user_text = payload.get("text", "")
        # 取得熱門幣種即時價格
        prices_info = ""
        try:
            btc = fetch_max_ticker("btctwd")
            eth = fetch_max_ticker("ethtwd")
            sol = fetch_max_ticker("soltwd")
            prices_info = f"BTC: ${btc.get('price', 'N/A')}, ETH: ${eth.get('price', 'N/A')}, SOL: ${sol.get('price', 'N/A')} (TWD)"
        except Exception as e:
            prices_info = "暫時無法取得最新報價"

        topic = payload.get("topic", "未指定幣種")
        prompt = f"Human: 你是一位專業的 AI 投資助理。目前畫面停留在【{topic}】。用戶提問：「{user_text}」。請用大約 30~50 字內簡短回答，若用戶詢問價格或行情，請參考以下最新市場即時價格資料：\n{prices_info}\n\nAssistant:"
        
        body = json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 150,
            "temperature": 0.5,
            "messages": [{"role": "user", "content": [{"type": "text", "text": prompt}]}]
        })
        
        def _invoke():
            response = bedrock_client.invoke_model(
                modelId='us.anthropic.claude-sonnet-4-6',
                body=body
            )
            return json.loads(response.get('body').read()).get('content')[0]['text']
            
        try:
            res_text = BedrockGate.invoke(_invoke)
            self.respond_json({"text": res_text.strip()})
        except Exception as e:
            print(f"Chat Assistant Error: {e}")
            self.respond_json({"text": f"連線異常，無法回應。({str(e)})"})

    def handle_chat_debate(self, payload):
        history = payload.get("history", [])
        
        history_str = ""
        for msg in history:
            name = msg.get("name", "Unknown")
            text = msg.get("text", "")
            history_str += f"[{name}]: {text}\n"

        def _invoke_single_agent(role_name, context):
            if not getattr(sys.modules[__name__], 'bedrock_client', None):
                return {"text": "Bedrock 未初始化"}
            
            topic = payload.get("topic", "目前鎖定的加密貨幣")
            prompt = f"Human: 你現在是針對【{topic}】進行辯論的 AI 投資委員會「{role_name}」。\n以下是目前的辯論歷史紀錄：\n{history_str}\n請根據你的專業（{context}），針對最後一位人類使用者的發言進行反駁或贊同，提出你的觀點。回覆請簡短有力（40字內）。\n\nAssistant:"
            body = json.dumps({
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 150,
                "temperature": 0.7,
                "messages": [{"role": "user", "content": [{"type": "text", "text": prompt}]}]
            })
            def _do_invoke():
                response = bedrock_client.invoke_model(
                    modelId='anthropic.claude-haiku-4-5-20251001-v1:0',
                    body=body
                )
                return json.loads(response.get('body').read()).get('content')[0]['text']
            
            try:
                res = BedrockGate.invoke(_do_invoke)
                return {"text": res.strip()}
            except Exception as e:
                print(f"Bedrock Chat Error ({role_name}): {e}")
                return {"text": f"無法回應 ({e})"}

        agents = [
            {"agent": "tech", "name": "技術分析師", "icon": "📈", "color": "var(--primary)", "context": "技術指標與線圖"},
            {"agent": "risk", "name": "風控長", "icon": "🛡️", "color": "var(--warning)", "context": "風險評估與保本"},
            {"agent": "sent", "name": "情緒分析師", "icon": "🌐", "color": "var(--success)", "context": "市場貪婪恐慌情緒"},
            {"agent": "behav", "name": "人格分析師", "icon": "🧠", "color": "var(--secondary)", "context": "投資人心理與紀律"}
        ]
        
        responses = []
        for ag in agents:
            reply = _invoke_single_agent(ag["name"], ag["context"])
            responses.append({
                "agent": ag["agent"],
                "name": ag["name"],
                "icon": ag["icon"],
                "color": ag["color"],
                "text": reply["text"]
            })
            
        self.respond_json({"debates": responses})

    def handle_conclude_debate(self, payload):
        history = payload.get("history", [])
        
        history_str = ""
        for msg in history:
            name = msg.get("name", "Unknown")
            text = msg.get("text", "")
            history_str += f"[{name}]: {text}\n"
            
        def _invoke_chair():
            if not getattr(sys.modules[__name__], 'bedrock_client', None):
                return '{"final_action": "HOLD", "summary": "Bedrock API 未連接"}'
                
            topic = payload.get("topic", "目前鎖定的加密貨幣")
            prompt = f"Human: 你現在是 AI 投資委員會的「主席 Agent」。你們剛才針對【{topic}】進行了辯論。\n以下是剛剛的所有辯論紀錄：\n{history_str}\n請你總結所有代理人與人類的意見，進行最終決議。\n**警告：絕對禁止自行捏造（Hallucinate）任何未在上述對話中出現的具體數字、百分比或評分（例如：技術得分 43、風險 10 分等）。請嚴格依據對話內容進行純邏輯總結。**\n必須以嚴格的 JSON 格式輸出（不要有任何 markdown 標籤或多餘文字），格式如下：\n{{\"summary\": \"你的綜合點評(50字內)\", \"final_action\": \"BUY\" 或 \"SELL\" 或 \"HOLD\"}}\n\nAssistant:"
            body = json.dumps({
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 200,
                "temperature": 0.5,
                "messages": [{"role": "user", "content": [{"type": "text", "text": prompt}]}]
            })
            response = bedrock_client.invoke_model(
                modelId='anthropic.claude-haiku-4-5-20251001-v1:0',
                body=body
            )
            return json.loads(response.get('body').read()).get('content')[0]['text']
            
        try:
            result = BedrockGate.invoke(_invoke_chair)
            clean_result = result.replace('```json', '').replace('```', '').strip()
            data = json.loads(clean_result)
        except Exception as e:
            print(f"Chair Parsing Error: {e}\nRaw output: {result if 'result' in locals() else 'None'}")
            data = {"final_action": "HOLD", "summary": "API 或 JSON 解析失敗，強制觀望。"}
            
        self.respond_json(data)

    def handle_extract_topic(self, payload):
        user_text = payload.get("text", "")
        if not user_text:
            self.respond_json({"topic": "btcusdt"})
            return
            
        prompt = f"Human: 你是一個虛擬貨幣實體識別助理。使用者輸入了一段文字：「{user_text}」。請判斷使用者正在討論哪一個加密貨幣。請直接回傳該貨幣對 USDT 的交易對代碼（例如：btcusdt, ethusdt, solusdt, dogeusdt）。如果無法判斷，請直接回傳 'btcusdt'。請勿輸出任何其他文字或標點符號，只能輸出代碼本身。\n\nAssistant:"
        
        body = json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 50,
            "temperature": 0.0,
            "messages": [{"role": "user", "content": [{"type": "text", "text": prompt}]}]
        })
        
        def _invoke():
            if getattr(sys.modules[__name__], 'bedrock_client', None):
                res = bedrock_client.invoke_model(
                    modelId='anthropic.claude-haiku-4-5-20251001-v1:0',
                    body=body
                )
                return json.loads(res.get('body').read()).get('content')[0]['text'].strip().lower()
            return "btcusdt"
            
        try:
            topic = BedrockGate.invoke(_invoke)
            # Basic sanitization
            topic = topic.replace(" ", "").replace("\n", "").replace("`", "")
            if "doge" in topic: topic = "dogeusdt"
            elif "sol" in topic: topic = "solusdt"
            elif "eth" in topic: topic = "ethusdt"
            elif "btc" in topic: topic = "btcusdt"
            else: topic = "btcusdt"
            
            self.respond_json({"topic": topic})
        except Exception as e:
            print(f"Extract Topic Error: {e}")
            self.respond_json({"topic": "btcusdt"})

def fetch_max_ticker(market):
    """向 MAX 取得即時報價。

    P10：取得失敗時一律回傳 dataSource="unavailable" 並將數值留空，
    絕不回傳任何硬編碼的替代價格，避免前端顯示看似正常的假數字。
    """
    url = f"https://max-api.maicoin.com/api/v2/tickers/{market}"
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
        with urllib.request.urlopen(req, timeout=3) as res_req:
            res = json.loads(res_req.read().decode('utf-8'))
        last_price = float(res["last"])
        open_price = float(res["open"])
        if open_price == 0:
            raise ValueError("open price 為 0，無法計算 24h 變動率")
        change = ((last_price - open_price) / open_price) * 100
        return {
            "price": last_price,
            "change24h": round(change, 2),
            "volume": float(res.get("vol", 0) or 0),
            "dataSource": "live",
        }
    except (urllib.error.HTTPError, urllib.error.URLError, socket.timeout, TimeoutError,
            json.JSONDecodeError, KeyError, TypeError, ValueError, OSError) as exc:
        detail = "{0}: {1}".format(type(exc).__name__, exc)
        print("[WARN] MAX ticker 取得失敗，已標記 dataSource=unavailable: {0}".format(detail))
        return {
            "price": None,
            "change24h": None,
            "volume": None,
            "dataSource": "unavailable",
            "error": detail,
        }

class ThreadedTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True

def run_server():
    with ThreadedTCPServer((HOST, PORT), CommitteeAPIHandler) as httpd:
        print(f"2/3 API Server is running indefinitely on http://localhost:{PORT}")
        httpd.serve_forever()

# 背景啟動 API 伺服器
server_thread = threading.Thread(target=run_server, daemon=True)
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
