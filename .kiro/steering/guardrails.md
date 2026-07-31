---
inclusion: always
---

# 開發紅線 (Guardrails) — AI 投資委員會 / Team 10

本檔為架構凍結後的強制規範。任何開發任務若與本檔衝突，一律以本檔為準並駁回變更。有疑慮時停下來詢問 System Integrator，不得因效能、便利或美觀自行放寬。

編號沿用《01-專案基準規格書(Baseline_Spec).md》第 8 章，請勿重新編號。

## 紅線 1：單一 Port 原則（架構凍結與單點啟動）

全端部署與 API Proxy 統一由 `start_demo.py` 承載於 **127.0.0.1:8080**，嚴禁拆分為多個 Port。

成因：前端曾直接呼叫 `max-api.maicoin.com` 遭 CORS 阻擋，`try/catch` 靜默載入假資料，追查耗時。

必須：
- 前端所有 `fetch()` 使用相對路徑（`/api/report`、`/api/market`、`/api/trade`、`/api/proxy?path=`、`agent_report.json`）
- 新增外部資料源一律經 `/api/proxy?path=` 轉發
- Java `ServerApp`（Spring Boot）為同契約備援實作，與 Python 不得同時佔用 8080

禁止：
- 新增任何對外監聽埠、獨立 dev server、第二個後端行程
- 前端出現絕對 URL 或跨來源請求
- 以 `Access-Control-Allow-Origin` 以外的手段繞道 CORS

違規判定：出現非 8080 的對外監聽埠；前端出現絕對 URL 或跨來源 `fetch`。

## 紅線 2：前端零依賴

K 線圖、十字游標、磁吸收盤價、OHLC Tooltip、6 檔盤口深度條全部維持 **原生 SVG + Vanilla JS**。

成因：自研 SVG 互動邏輯已完成，引入圖表庫會作廢既有邏輯並增加載入負擔與離線風險。

禁止引入 React、Vue、Chart.js、D3.js 或任何前端框架／圖表庫；禁止新增 `package.json`、npm 依賴、建置步驟或 CDN `<script src>`。

必須：圖表增強一律擴充 `web/app.js` 既有 SVG 繪製函式。

違規判定：`web/**` 出現 `react`／`vue`／`chart.js`／`d3` 字樣或 CDN script 標籤；`index.html` 的 `<script src>` 指向非同目錄本地檔案。

## 紅線 3：Windows 編碼安全

Windows 預設 cp950，中文 JSON／CSV／log 讀寫會產生亂碼，且錯誤常在展演現場才浮現。

必須：
- 所有文字模式 `open()` 顯式帶 `encoding='utf-8'`
- `subprocess.run(..., text=True)` 一併帶 `encoding='utf-8'`，建議加 `errors='replace'`
- JSON 輸出維持 `ensure_ascii=False`
- R 端 `read.csv()` 帶 `fileEncoding="UTF-8"`

```python
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)

with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

subprocess.run(cmd, capture_output=True, text=True,
               encoding="utf-8", errors="replace", timeout=60)
```

違規判定：存在未帶 `encoding` 的文字模式 `open()`；存在未帶 `encoding` 的 `text=True` subprocess；輸出檔案以 cp950 落地。

## 紅線 4：AWS Bedrock 限流（1 RPS）

Bedrock 配額為每秒 1 請求，4 位 Agent 若並行呼叫必然觸發 ThrottlingException，導致辯論流程中斷。

必須：
- 所有 Bedrock 呼叫收斂至單一佇列閘道，逐一同步執行
- 相鄰呼叫間隔 ≥ 1000ms，並含指數退避重試
- 4 Agent 採循序輪替，不得扇出

禁止：`ThreadPoolExecutor`、`asyncio.gather`、`CompletableFuture.allOf` 等併發原語套用於 Bedrock 路徑。

閘道基準實作（新增 Bedrock 呼叫請一律經此路徑）：

```python
import threading, time

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
```

違規判定：Bedrock 呼叫路徑同時在途請求數 > 1；相鄰兩次呼叫間隔 < 1000ms；呼叫被包在任何併發／執行緒池結構中。

## 對應的正確性性質

| ID | 紅線 | 性質 |
|---|---|---|
| P1 | 1 | 專案對外 HTTP 監聽埠集合恆等於 `{8080}` |
| P2 | 1 | 前端所有網路請求 URL 皆為相對路徑 |
| P3 | 2 | `web/**` 不含 `react`／`vue`／`chart.js`／`d3` 任何引用 |
| P4 | 2 | `index.html` 的 `<script src>` 僅指向同目錄本地檔案 |
| P5 | 3 | 所有 `.py` 文字模式 `open()` 與 `text=True` subprocess 均帶 `encoding='utf-8'` |
| P6 | 3 | 中文字串寫入再讀回後恆等（round-trip 不變性） |
| P7 | 4 | Bedrock 閘道並行度上限恆等於 1 |
| P8 | 4 | 任意兩次相鄰 Bedrock 呼叫時間差 ≥ 1000ms |

## 提交前自檢

1. 有沒有新增監聽埠，或前端出現絕對 URL？
2. `web/` 有沒有多出任何外部依賴？
3. 新寫的 Python 檔案 I/O 與 subprocess 有沒有帶 `encoding='utf-8'`？
4. Bedrock 呼叫有沒有走 `BedrockGate` 單一閘道？

四項全過才算任務完成。不確定就問，不要自行妥協。
