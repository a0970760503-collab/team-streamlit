# 需求文件：Demo 安全強化（demo-security-hardening）

## 簡介

本規格處理「AI 投資委員會」黑客松專案在 Demo 前的一輪程式碼審查發現，範圍涵蓋 15 項（A–O）：真實資金下單端點缺乏認證、開放代理造成的 SSRF、環境範本與依賴清單缺漏、錯誤訊息外洩與編碼中斷、重複程式碼與裸 except、假數字殘留、文件漂移與紅線檢查失效、四項邏輯漏改與孤島程式碼，以及 Bedrock 呼叫繞過單一閘道的臨時腳本。

修正一律在既有架構內完成，不得違反 `.kiro/steering/guardrails.md` 的四條紅線：

- 單一對外監聽埠恆等於 `{8080}`
- 前端維持原生 SVG + Vanilla JS 零依賴
- 所有 Python 文字模式 I/O 與 `text=True` subprocess 皆帶 `encoding='utf-8'`
- 所有 Bedrock 呼叫經 `BedrockGate`，並行度恆為 1 且相鄰呼叫間隔 ≥ 1000ms

本文件僅定義「要達成什麼」，不定義實作方式。文末「已裁定事項」記錄 Q1–Q6 的裁定結果與理由，作為決策軌跡；相關驗收標準已依裁定結果固化為具體判定值。

### 現況確認摘要（讀碼結果）

| 審查項 | 現況位置 | 確認狀態 |
|---|---|---|
| A | `start_demo.py` `do_OPTIONS`／`respond_json` 回 `Access-Control-Allow-Origin: *`；`handle_trade` 在有 `MAX_ACCESS_KEY`／`MAX_SECRET_KEY` 時直接對 MAX 下單 | 成立 |
| B | `handle_proxy` 以 `url = f"https://max-api.maicoin.com{target_path}"` 組址，`target_path` 全由 query 決定，無白名單 | 成立 |
| C | `.env.example` 僅含 `CMC_API_KEY`；程式另需 `AWS_DEFAULT_REGION`、`MAX_ACCESS_KEY`、`MAX_SECRET_KEY` 與 AWS 憑證 | 成立 |
| D | 專案無 `requirements.txt`，`start_demo.py` 已 `import boto3`、`from dotenv import load_dotenv` | 成立 |
| E | `send_error(500, f"Proxy Error: {str(e)}")`、`f"❌ 真實 API 下單失敗: {str(e)}"`、`f"連線異常，無法回應。({str(e)})"` | 成立 |
| F | `send_error()` 訊息進入 HTTP status line，`http.server` 以 latin-1 編碼 | 成立 |
| G | `do_POST` 四個分支各自複製「讀 `Content-Length` + `json.loads`」，且使用裸 `except:` | 成立 |
| H | `import random` 用於 `agent_report.json` 讀取失敗時的 RSI；`web/app.js` `generateDynamicSpeech` 亦以 `Math.random()` 拼發言 | 成立（範圍比原審查更大） |
| I | 基準規格書存在兩份且內容已漂移 | 成立 |
| J | `BIND_RE` 只匹配字面 host+port，程式用 `(HOST, PORT)` 變數；無 P7／P8 檢查 | 成立 |
| K | `debates` 中情緒面 `score` 寫死 `"68"`、行為面寫死 `"80"`；另 `buy_votes` 先由報告讀入後被覆寫，屬同類漏改 | 成立 |
| L | `invoke_claude` 在 `bedrock_client` 為 `None` 時回傳 `HOLD`，四票皆 HOLD → `holdPercentage` 100、`confidenceScore` 100 | 成立 |
| M | `handle_report` 連續呼叫 Claude 4 次，經 `BedrockGate` 序列化 | 成立 |
| N | `src/main/java/api/ServerApp.java` 未被 `start_demo.py` 啟動，仍含 `Math.random()` RSI 與 `65 + Math.random()*10` 票數 | 成立 |
| O | 根目錄 `find_46.py`、`list_models.py`、`test_invoke.py`、`test_model.py` 四個臨時腳本；其中 `test_invoke.py`、`test_model.py` 各自建立 `boto3.client('bedrock-runtime')` 並直接 `invoke_model`，完全繞過 `BedrockGate`；`check_guardrails.py` 抓不到此繞道 | 成立 |

## 名詞定義

- **Demo_Server**：`team-streamlit/start_demo.py` 執行的 `http.server` 行程，承載靜態檔與所有 `/api/*` 端點。
- **Trade_Endpoint**：`POST /api/trade`。
- **Proxy_Endpoint**：`GET /api/proxy`。
- **Report_Endpoint**：`GET /api/report`，由 `handle_report` 實作。
- **Chat_Endpoints**：`POST /api/chat_assistant`、`POST /api/chat_debate`、`POST /api/conclude_debate`。
- **Bedrock_Gate**：`start_demo.py` 中的 `BedrockGate` 類別，序列化所有 Bedrock 呼叫。
- **Frontend_UI**：`team-streamlit/web/` 下的 `index.html` 與 `app.js`。
- **Env_Template**：`team-streamlit/.env.example`。
- **Dependency_Manifest**：宣告 Python 執行期依賴的清單檔（如 `requirements.txt`）。
- **Guardrail_Checker**：`team-streamlit/scripts/check_guardrails.py`。
- **Baseline_Spec**：專案基準規格書，現存於 `0-專案說明與文檔/01-專案基準規格書(Baseline_Spec).md` 與 `team-streamlit/.kiro/specs/project-baseline-spec/` 兩處。
- **Legacy_Java_Server**：`team-streamlit/src/main/java/api/ServerApp.java`。已裁定移除（見已裁定事項 Q6）。
- **允許來源清單（Allowed_Origins）**：`{http://127.0.0.1:8080, http://localhost:8080}`。僅用於 Trade_Endpoint 的 `Origin` 標頭比對，屬深度防禦第二層；不作為 CORS 標頭輸出依據（見已裁定事項 Q2）。
- **代理路徑白名單（Proxy_Allowlist）**：`{/api/v2/k, /api/v2/depth, /api/v2/tickers, /api/v2/tickers/{market}}`，其中 `market` 須匹配 `^[a-z0-9]{3,20}$`（見已裁定事項 Q3）。
- **授權憑證（Demo_Auth_Token）**：Demo_Server 每次啟動時重新產生、僅存於行程記憶體、不寫入任何檔案的隨機憑證，由伺服器在回應 `index.html` 時注入 Frontend_UI（見已裁定事項 Q1）。
- **不可用狀態（Unavailable_State）**：外部資料源或 Bedrock 無法取得有效結果的狀態，對應 `dataSource == "unavailable"` 或 `bedrock_client is None`。
- **不可用標示（PRICE_UNAVAILABLE）**：數值位置顯示 `--` 的既有慣例，延伸適用於所有不可用狀態（見已裁定事項 Q4）。
- **臨時腳本（Temp_Scripts）**：`team-streamlit/` 根目錄下的探索用腳本 `find_46.py`、`list_models.py`、`test_invoke.py`、`test_model.py`。

## 需求

### 需求 1：交易端點的請求授權（審查項 A）

**嚴重度：高**

**使用者故事：** 作為 Demo 主講者，我要 Trade_Endpoint 只接受來自本專案畫面的下單請求，這樣即使我在同一台機器開了其他網頁，也不會有第三方網站在我的瀏覽器裡偽造下單紀錄或 Mock 訂單。

風險說明：`do_OPTIONS` 與 `respond_json` 皆回 `Access-Control-Allow-Origin: *` 且允許 `Content-Type`，任意網站的 JavaScript 可對 `http://127.0.0.1:8080/api/trade` 發出 POST。綁定 `127.0.0.1` 僅阻擋外部主機，不阻擋本機瀏覽器發起的請求。

裁定前提（Q1）：Demo 期間不設定 `MAX_ACCESS_KEY`／`MAX_SECRET_KEY`，Trade_Endpoint 恆走 Mock 引擎，零真實資金風險；認證仍為必要，用以阻止第三方網站偽造下單紀錄與 Mock 訂單。主要防護為 Demo_Auth_Token，`Origin` 檢查為深度防禦第二層。

#### 驗收標準

1. WHEN Trade_Endpoint 收到不帶有效 Demo_Auth_Token 的 POST 請求，THE Demo_Server SHALL 回傳 HTTP 401，且不產生任何下單紀錄與 Mock 訂單，並不呼叫任何外部下單 API
2. WHEN Trade_Endpoint 收到帶有效 Demo_Auth_Token 的 POST 請求且 `MAX_ACCESS_KEY` 與 `MAX_SECRET_KEY` 皆未設定，THE Demo_Server SHALL 以 Mock 引擎產生下單結果並回傳，且不發出任何對外下單請求
3. WHEN Trade_Endpoint 收到 `Origin` 標頭且其值不等於 `http://127.0.0.1:8080` 或 `http://localhost:8080`，THE Demo_Server SHALL 回傳 HTTP 403，且不產生任何下單紀錄與 Mock 訂單
4. THE Demo_Server SHALL 不在任何回應中輸出 `Access-Control-Allow-Origin`、`Access-Control-Allow-Methods` 或 `Access-Control-Allow-Headers` 標頭
5. THE Demo_Server SHALL 移除 `do_OPTIONS` 對 `/api/*` 路徑的 CORS 預檢回應
6. WHEN Demo_Server 啟動，THE Demo_Server SHALL 產生一組僅存於行程記憶體的 Demo_Auth_Token，將其值輸出至執行終端一次，且不寫入任何檔案
7. WHEN Demo_Server 回應 `index.html` 請求，THE Demo_Server SHALL 將當次啟動產生的 Demo_Auth_Token 注入該回應內容，供 Frontend_UI 於後續 Trade_Endpoint 請求帶上
8. WHEN Demo_Server 啟動且偵測到 `MAX_ACCESS_KEY` 或 `MAX_SECRET_KEY` 已設定，THE Demo_Server SHALL 於終端輸出高風險警示，明示當前為真實資金下單模式
9. WHEN Demo_Auth_Token 驗證失敗，THE Demo_Server SHALL 於終端記錄一筆含時間戳、請求路徑與 `Origin` 值的稽核訊息

### 需求 2：代理端點的目標路徑白名單（審查項 B）

**嚴重度：高**

**使用者故事：** 作為專案負責人，我要 Proxy_Endpoint 只能轉發到事先核可的 MAX API 路徑，這樣它就不會被當成 SSRF 跳板去存取攻擊者主機或內部網段。

風險說明：`url = f"https://max-api.maicoin.com{target_path}"` 中 `target_path` 完全由 query 參數 `path` 決定。`path=@evil.com/x` 會使實際 URL 成為 `https://max-api.maicoin.com@evil.com/x`，依 URL 語法 `max-api.maicoin.com` 被解析為使用者資訊，請求送往 `evil.com`。

白名單依據（Q3，已核對 `web/app.js`）：前端實際使用四種路徑——`/api/v2/k`（`fetchMaxKlineData`，K 線圖）、`/api/v2/depth`（盤口深度委託）、`/api/v2/tickers`（全幣種行情列表）、`/api/v2/tickers/{market}`（單一幣種即時價）。**白名單若遺漏任一項，會使 K 線圖、盤口委託或行情列表功能失效。**

#### 驗收標準

1. WHEN Proxy_Endpoint 收到 `path` 參數，THE Demo_Server SHALL 僅在該值等於 `/api/v2/k`、`/api/v2/depth`、`/api/v2/tickers`，或符合 `/api/v2/tickers/{market}` 且 `market` 匹配 `^[a-z0-9]{3,20}$` 時發出對外請求
2. IF `path` 參數不等於 `/api/v2/k`、`/api/v2/depth`、`/api/v2/tickers`，且不符合 `market` 匹配 `^[a-z0-9]{3,20}$` 的 `/api/v2/tickers/{market}` 形式，THEN THE Demo_Server SHALL 回傳 HTTP 400 且不發出任何對外網路請求
3. IF `path` 參數包含 `@`、`\`、`//`、`..` 或非 `/` 起始字元，THEN THE Demo_Server SHALL 回傳 HTTP 400 且不發出任何對外網路請求
4. THE Demo_Server SHALL 在發出對外請求前，驗證組出的 URL 之 scheme 為 `https` 且 host 恆等於 `max-api.maicoin.com`
5. IF 組出的 URL 之 host 不等於 `max-api.maicoin.com`，THEN THE Demo_Server SHALL 回傳 HTTP 400 且不發出該請求
6. WHEN 對外請求回應 3xx 轉址，THE Demo_Server SHALL 中止該次轉發並回傳 HTTP 502
7. THE Demo_Server SHALL 不在 Proxy_Endpoint 的任何回應中輸出 `Access-Control-Allow-Origin`、`Access-Control-Allow-Methods` 或 `Access-Control-Allow-Headers` 標頭
8. THE Frontend_UI SHALL 以相對路徑呼叫 Proxy_Endpoint，使該請求恆為同源請求

### 需求 3：環境變數範本與程式所需變數一致（審查項 C）

**嚴重度：中**

**使用者故事：** 作為新加入的組員，我要 `.env.example` 列出程式實際會讀取的每一個環境變數，這樣我不必為了讓程式跑起來而把金鑰硬寫進原始碼。

現況：Env_Template 僅含 `CMC_API_KEY`；程式另讀取 `AWS_DEFAULT_REGION`、`MAX_ACCESS_KEY`、`MAX_SECRET_KEY`，並經 boto3 預設鏈使用 AWS 憑證。

#### 驗收標準

1. THE Env_Template SHALL 列出 `AWS_DEFAULT_REGION`、`MAX_ACCESS_KEY`、`MAX_SECRET_KEY`、`CMC_API_KEY` 四個變數名稱
2. THE Env_Template SHALL 對每個變數以註解標示該變數的用途、必填或選填，以及未設定時系統的行為
3. THE Env_Template SHALL 對每個變數以佔位字串作為值，且佔位字串不含任何可用的憑證
4. THE Env_Template SHALL 標示 AWS 憑證的取得方式，並指出 `.env` 已在 `.gitignore` 內
5. THE Env_Template SHALL 於 `MAX_ACCESS_KEY` 與 `MAX_SECRET_KEY` 的註解標示「Demo 期間留空，留空時 Trade_Endpoint 走 Mock 引擎」
6. WHEN Demo_Server 啟動且必填變數缺漏，THE Demo_Server SHALL 於終端輸出缺漏的變數名稱清單
7. WHEN Guardrail_Checker 執行，THE Guardrail_Checker SHALL 比對程式碼中讀取的環境變數名稱集合與 Env_Template 宣告的集合，並在前者不為後者子集時回報違規

### 需求 4：Python 依賴清單（審查項 D）

**嚴重度：中**

**使用者故事：** 作為在乾淨環境重現 Demo 的評審或組員，我要一份依賴清單，這樣我照著單一啟動指令就能跑起來，不會撞上 `ImportError`。

現況：專案僅有 `pom.xml`（Java），無 Python 依賴清單，但 `start_demo.py` 已 import `boto3` 與 `dotenv`。

#### 驗收標準

1. THE Dependency_Manifest SHALL 列出 `boto3` 與 `python-dotenv`，並各自指定固定版本號
2. THE Dependency_Manifest SHALL 涵蓋 `team-streamlit/` 下所有 `.py` 檔案 import 的非標準函式庫模組
3. THE README SHALL 記載安裝依賴的指令與啟動指令，且啟動後對外監聽埠僅為 8080
4. WHEN 於未安裝依賴的環境執行啟動指令，THE Demo_Server SHALL 在終端輸出指向 Dependency_Manifest 的安裝提示，而非僅拋出未處理的 `ImportError` 追蹤堆疊
5. WHEN Guardrail_Checker 執行，THE Guardrail_Checker SHALL 在偵測到程式 import 了未列於 Dependency_Manifest 的第三方模組時回報違規

### 需求 5：錯誤訊息不外洩內部細節（審查項 E）

**嚴重度：低**

**使用者故事：** 作為 Demo 主講者，我要畫面上的錯誤訊息只說「哪裡不可用、我該怎麼做」，這樣不會在投影幕上出現含內部路徑、金鑰片段或堆疊資訊的原始例外文字。

現況：`Proxy Error: {str(e)}`、`❌ 真實 API 下單失敗: {str(e)}`、`連線異常，無法回應。({str(e)})` 皆將例外原文送往前端。

#### 驗收標準

1. WHEN 任一 `/api/*` 端點發生未預期例外，THE Demo_Server SHALL 回傳固定措辭的使用者訊息與一組錯誤代碼，且回應內容不含例外類別名稱、例外原文、檔案路徑或堆疊資訊
2. WHEN 任一 `/api/*` 端點發生未預期例外，THE Demo_Server SHALL 於終端輸出含該錯誤代碼與完整例外資訊的紀錄
3. THE Demo_Server SHALL 使前端回應中的錯誤代碼與終端紀錄中的錯誤代碼可一對一對應
4. THE Demo_Server SHALL 在任何回應內容中排除 `MAX_ACCESS_KEY`、`MAX_SECRET_KEY`、AWS 憑證與 Demo_Auth_Token 的值

### 需求 6：HTTP 狀態列僅使用可安全編碼的字元（審查項 F）

**嚴重度：低**

**使用者故事：** 作為 Demo 主講者，我要錯誤回應永遠能完整送達瀏覽器，這樣不會因為錯誤訊息含中文就讓連線直接中斷、畫面卡在載入中。

風險說明：`http.server` 以 latin-1 編碼 status line，`send_error()` 的 `message` 參數含非 latin-1 字元時會拋 `UnicodeEncodeError` 並中斷該請求。

#### 驗收標準

1. THE Demo_Server SHALL 使所有傳入 `send_error()` 的 reason phrase 僅包含 ASCII 字元
2. WHEN 需要向使用者呈現中文錯誤說明，THE Demo_Server SHALL 以 `Content-Type: application/json; charset=utf-8` 的回應主體承載該說明
3. WHEN 任一 `/api/*` 端點以錯誤狀態碼回應，THE Demo_Server SHALL 完成該回應的傳送而不拋出 `UnicodeEncodeError`
4. WHEN Guardrail_Checker 執行，THE Guardrail_Checker SHALL 在偵測到 `send_error()` 的字面訊息含非 ASCII 字元時回報違規

### 需求 7：POST 請求主體解析集中化與例外收斂（審查項 G）

**嚴重度：整潔**

**使用者故事：** 作為維護者，我要 POST 主體的讀取與解析只有一份實作，這樣四個端點的行為一致，而且 Ctrl+C 一定能停掉伺服器。

現況：`do_POST` 四個分支各自複製「讀 `Content-Length` + `json.loads`」，且使用裸 `except:`，會吞掉 `KeyboardInterrupt` 與 `SystemExit`。

#### 驗收標準

1. THE Demo_Server SHALL 以單一共用函式讀取並解析所有 POST 端點的請求主體
2. WHEN POST 請求主體不是合法 JSON，THE Demo_Server SHALL 回傳 HTTP 400 並附固定措辭的說明
3. WHEN POST 請求的 `Content-Length` 缺漏或不是非負整數，THE Demo_Server SHALL 回傳 HTTP 400
4. WHEN POST 請求主體長度超過設定上限，THE Demo_Server SHALL 回傳 HTTP 413 且不讀取超出上限的位元組
5. THE Demo_Server SHALL 在所有 `except` 子句中指定明確的例外類別，使 `KeyboardInterrupt` 與 `SystemExit` 得以向外傳播
6. WHEN 使用者於終端按下 Ctrl+C，THE Demo_Server SHALL 結束行程並輸出關閉訊息
7. WHEN Guardrail_Checker 執行，THE Guardrail_Checker SHALL 在偵測到裸 `except:` 或 `except BaseException` 時回報違規

### 需求 8：移除隨機產生的假數值（審查項 H）

**嚴重度：整潔**

**使用者故事：** 作為評審，我要畫面上每個數字都能追溯到真實資料來源，這樣我不會把隨機產生的數值誤認為分析結果。

現況：`start_demo.py` 在 `agent_report.json` 讀取失敗時以 `random.random()` 產生 RSI；`web/app.js` 的 `generateDynamicSpeech` 以 `Math.random()` 隨機挑選發言字串。Guardrail_Checker 目前只比對已知硬編碼字面值，抓不到隨機來源的假值。

#### 驗收標準

1. THE Demo_Server SHALL 不使用 `random` 模組產生任何呈現於 Frontend_UI 的數值
2. WHEN `agent_report.json` 讀取或解析失敗，THE Demo_Server SHALL 將對應欄位標記為不可用狀態並將數值留空，而非以計算或隨機方式產生替代值
3. THE Frontend_UI SHALL 不使用 `Math.random()` 產生任何呈現於畫面的數值或分析結論文字
4. WHEN 任一分析數值或報價處於不可用狀態，THE Frontend_UI SHALL 於該數值位置顯示 `--`，並於同一區塊顯示該數值上次成功取得的時間戳與一個重試操作
5. THE Frontend_UI SHALL 使「報價不可用」與「AI 分析不可用」兩種狀態具有可區分的文案與圖示
6. WHEN Guardrail_Checker 執行，THE Guardrail_Checker SHALL 在 `start_demo.py` 出現 `random` 模組呼叫或 `web/**` 出現 `Math.random(` 時回報違規

### 需求 9：基準規格書單一來源與內容更正（審查項 I）

**嚴重度：整潔**

**使用者故事：** 作為組員，我要只有一份基準規格書且內容與程式一致，這樣我讀到的架構描述不會與實際行為相反。

現況：`0-專案說明與文檔/01-專案基準規格書(Baseline_Spec).md` 與 `team-streamlit/.kiro/specs/project-baseline-spec/` 兩份內容已漂移，皆仍記載「RSI 與投票含 random」「Bedrock 未接入」，並誤述 `/api/proxy` 為「白名單式轉發」——實際上目前沒有白名單。

#### 驗收標準

1. THE 專案 SHALL 指定唯一一份 Baseline_Spec 為權威版本
2. THE 非權威版本的 Baseline_Spec SHALL 於檔首標示為已停用，並提供指向權威版本的路徑
3. THE 權威版本 Baseline_Spec SHALL 記載 Bedrock 已接入且所有呼叫經 Bedrock_Gate
4. THE 權威版本 Baseline_Spec SHALL 記載 RSI 與委員會票數的實際來源，並移除「含 random」的敘述
5. THE 權威版本 Baseline_Spec SHALL 記載 Proxy_Endpoint 的實際白名單狀態，並在需求 2 完成前標示「無白名單，屬已知風險」
6. THE 權威版本 Baseline_Spec SHALL 記載經實測可成功呼叫的 Bedrock modelId
7. THE 權威版本 Baseline_Spec SHALL 記載 Legacy_Java_Server 已移除，且備援實作敘述不再指向該檔

### 需求 10：紅線檢查器覆蓋實際程式寫法（審查項 J）

**嚴重度：整潔**

**使用者故事：** 作為 System Integrator，我要紅線檢查器真的能抓到違規，這樣它給的「通過」才有意義。

現況：`BIND_RE` 只匹配帶引號的字面 host 加埠號，而程式寫成 `socketserver.TCPServer((HOST, PORT), ...)`，該規則實質失效；`P7`／`P8`（Bedrock 並行度與間隔）完全未被檢查，也不驗證 Bedrock 呼叫是否經 Bedrock_Gate。

#### 驗收標準

1. WHEN Guardrail_Checker 掃描以變數形式傳入的綁定位址與埠號，THE Guardrail_Checker SHALL 解析該變數在同一模組內的常數指派值並據以判定 P1
2. IF 綁定位址或埠號無法靜態解析為常數，THEN THE Guardrail_Checker SHALL 回報一項需人工確認的警示
3. WHEN Guardrail_Checker 掃描 Python 檔案，THE Guardrail_Checker SHALL 在偵測到 `invoke_model` 呼叫未包在 `BedrockGate.invoke` 的呼叫鏈內時回報違規
4. WHEN Guardrail_Checker 掃描 Python 檔案，THE Guardrail_Checker SHALL 在 Bedrock 呼叫出現於 `ThreadPoolExecutor`、`asyncio.gather` 或 `threading.Thread` 目標函式中時回報違規
5. THE Guardrail_Checker SHALL 對每條規則提供至少一組已知違規樣本與一組合規樣本，並使規則在違規樣本上回報違規、在合規樣本上不回報
6. WHEN Guardrail_Checker 執行完畢，THE Guardrail_Checker SHALL 輸出本次實際生效的規則編號清單

### 需求 11：委員會分數呈現真實資料（審查項 K）

**嚴重度：邏輯**

**使用者故事：** 作為評審，我要情緒面與行為面的分數隨資料變動，這樣我看到的委員會意見是分析結果而不是固定畫面。

現況：`handle_report` 已從 `agent_report.json` 讀出 `sentiment_score` 與 `behavior_score` 並餵給 Claude，但組 `debates` 時情緒面 `score` 寫死 `"68"`、行為面寫死 `"80"`。另 `buy_votes` 先由 `committee_score` 讀入後即被票數計算覆寫，屬同類漏改。

#### 驗收標準

1. WHEN Report_Endpoint 組出情緒面的辯論項目，THE Demo_Server SHALL 將 `score` 設為該次讀取到的 `sentiment_score`
2. WHEN Report_Endpoint 組出行為面的辯論項目，THE Demo_Server SHALL 將 `score` 設為該次讀取到的 `behavior_score`
3. WHEN `agent_report.json` 中兩次不同的 `sentiment_score` 或 `behavior_score` 被讀取，THE Report_Endpoint SHALL 使回應中對應的 `score` 值隨之不同
4. IF `sentiment_score` 或 `behavior_score` 於 `agent_report.json` 中缺漏，THEN THE Demo_Server SHALL 將對應 `score` 標記為不可用狀態
5. THE Demo_Server SHALL 移除 `handle_report` 中被後續計算覆寫而不影響輸出的變數指派
6. THE Demo_Server SHALL 使 Report_Endpoint 回應中每個數值欄位都能對應到 `agent_report.json` 欄位或即時報價欄位

### 需求 12：Bedrock 不可用時明示故障而非偽裝共識（審查項 L）

**嚴重度：邏輯**

**使用者故事：** 作為 Demo 主講者，我要在 Bedrock 連不上時畫面直接說「AI 分析目前不可用」，這樣我不會在投影幕上宣讀一個其實是故障造成的「HOLD 100%、信心 100%」決議。

現況：`bedrock_client` 為 `None` 時 `invoke_claude` 對四位 Agent 皆回 `HOLD`，票數計算得出 `holdPercentage` 100、`confidenceScore` 100。modelId 若不合法（見已裁定事項 Q5）會使四位 Agent 全部落入失敗分支，正是本需求描述的假共識情境。

#### 驗收標準

1. IF `bedrock_client` 為 `None`，THEN THE Report_Endpoint SHALL 在回應中將 AI 分析狀態標記為不可用狀態，且不輸出任何 `signal` 值
2. IF 任一 Agent 的 Bedrock 呼叫失敗，THEN THE Report_Endpoint SHALL 將該 Agent 的 `signal` 標記為不可用狀態，而非以 `HOLD` 代替
3. WHILE 任一 Agent 處於不可用狀態，THE Report_Endpoint SHALL 不輸出 `finalDecision` 與 `confidenceScore` 的數值，並改為輸出不可用標記
4. WHEN 所有四位 Agent 皆回傳有效 `signal`，THE Report_Endpoint SHALL 依票數計算 `finalDecision` 與 `confidenceScore`
5. WHEN Report_Endpoint 回應中 AI 分析狀態為不可用，THE Frontend_UI SHALL 於票數與信心度位置顯示 `--`、顯示上次成功取得的時間戳、提供重試操作，並使用與「報價不可用」可區分的文案與圖示，且不顯示任何票數百分比
6. IF `bedrock_client` 為 `None`，THEN THE Chat_Endpoints SHALL 回傳明示 AI 服務不可用的固定訊息，且該訊息不含例外原文
7. WHEN Demo_Server 啟動，THE Demo_Server SHALL 對設定的 modelId 執行一次連通性驗證，並在驗證失敗時於終端輸出該 modelId 與失敗原因

### 需求 13：報告端點回應時間與前端載入行為（審查項 M）

**嚴重度：邏輯**

**使用者故事：** 作為 Demo 主講者，我要在等待委員會分析時看到明確的進行中狀態，這樣不會因為畫面沒反應而重複點擊，把請求堆成一列。

現況：`handle_report` 連續呼叫 Claude 四次，經 Bedrock_Gate 序列化後單次估計耗時 8–15 秒。若前端以輪詢方式呼叫 Report_Endpoint，請求會排隊堆積。

#### 驗收標準

1. WHEN Frontend_UI 發出 Report_Endpoint 請求，THE Frontend_UI SHALL 於 500ms 內顯示載入中狀態
2. WHILE 已有一個 Report_Endpoint 請求在途，THE Frontend_UI SHALL 阻止再發出新的 Report_Endpoint 請求
3. THE Frontend_UI SHALL 不以固定間隔輪詢 Report_Endpoint
4. WHEN Report_Endpoint 請求超過 30 秒未收到回應，THE Frontend_UI SHALL 中止該請求，於數值位置顯示 `--`，顯示上次成功取得的時間戳與重試操作，並使用「AI 分析不可用」的文案與圖示
5. THE Demo_Server SHALL 在收到第二個並行的 Report_Endpoint 請求時回傳 HTTP 429 並附建議重試秒數
6. THE Demo_Server SHALL 對每次 Report_Endpoint 呼叫於終端記錄其總耗時與四次 Bedrock 呼叫各自的耗時
7. THE Demo_Server SHALL 使相鄰兩次 Bedrock 呼叫的時間差維持在 1000ms 以上

### 需求 14：移除孤島 Java 伺服器（審查項 N）

**嚴重度：邏輯**

**使用者故事：** 作為維護者，我要專案裡不留跑不到的伺服器實作，這樣我不會去維護一份永遠不會被啟動的程式碼，也不會讓含假數字的程式碼留在專案裡誤導他人。

現況：Legacy_Java_Server 未被 `start_demo.py` 啟動，仍含 `double rsi = 45.0 + (Math.random() * 20 - 10)` 與 `int buyVotes = 65 + (int)(Math.random() * 10)`。紅線 1 亦規定 Java 版與 Python 版不得同時佔用 8080。裁定結果（Q6）：移除。

#### 驗收標準

1. THE 專案 SHALL 不包含 `src/main/java/api/ServerApp.java`
2. THE 專案 SHALL 移除 `pom.xml` 中僅供 `src/main/java/api/ServerApp.java` 使用的依賴
3. THE 權威版本 Baseline_Spec SHALL 移除以 Legacy_Java_Server 作為備援實作的敘述，並記載 Demo_Server 為唯一伺服器實作
4. THE 專案 SHALL 不包含任何在移除後仍指向 Legacy_Java_Server 的建置設定、啟動腳本或文件連結
5. WHEN Guardrail_Checker 執行，THE Guardrail_Checker SHALL 在 `src/main/java/**` 偵測到 `Math.random()` 用於數值輸出時回報違規

### 需求 15：Bedrock 呼叫單一閘道與臨時腳本清理（審查項 O）

**嚴重度：高（紅線 4 違規風險）**

**使用者故事：** 作為 System Integrator，我要專案內不存在任何繞過 Bedrock_Gate 的 Bedrock 呼叫路徑，這樣 1 RPS 限制才真正成立，不會因為有人順手跑一支測試腳本就觸發 `ThrottlingException`。

現況（已核對）：`team-streamlit/` 根目錄散落四個探索用臨時腳本 `find_46.py`、`list_models.py`、`test_invoke.py`、`test_model.py`。其中 `test_invoke.py` 與 `test_model.py` 各自以 `boto3.client('bedrock-runtime')` 建立獨立客戶端並直接呼叫 `invoke_model`，完全繞過 Bedrock_Gate。若與 `start_demo.py` 同時執行，Bedrock 同時在途請求數會超過 1，直接違反紅線 4。`check_guardrails.py` 目前抓不到這種繞道。

#### 驗收標準

1. THE 專案 SHALL 使所有 `invoke_model` 呼叫皆經由 `BedrockGate.invoke` 執行
2. THE 專案 SHALL 僅在 `start_demo.py` 內建立 `bedrock-runtime` 客戶端
3. THE 專案 SHALL 不包含 `find_46.py`、`list_models.py`、`test_invoke.py`、`test_model.py` 於 `team-streamlit/` 根目錄
4. WHERE 上述四個腳本的內容需要保留，THE 專案 SHALL 將其移入明確標示為暫存用途的 `scratch/` 目錄，並將該目錄納入 `.gitignore`
5. WHEN Guardrail_Checker 執行，THE Guardrail_Checker SHALL 在偵測到 `start_demo.py` 以外的檔案建立 `bedrock-runtime` 客戶端時回報違規
6. WHEN Guardrail_Checker 執行，THE Guardrail_Checker SHALL 在偵測到未包在 `BedrockGate.invoke` 呼叫鏈內的 `invoke_model` 呼叫時回報違規（與需求 10.3 呼應）
7. WHEN Guardrail_Checker 執行，THE Guardrail_Checker SHALL 在 `team-streamlit/` 根目錄偵測到未列於 Dependency_Manifest 使用情境、且不屬於 `start_demo.py` 或 `scripts/` 的探索用 `.py` 檔案時回報違規

## 已裁定事項

以下取捨已由專案負責人裁定，對應驗收標準已固化為具體判定值。本節保留決策軌跡，開發者以裁定結果為準。

### Q1：Demo 期間的 MAX 金鑰設定與認證形式 — 裁定：選項 1a + token

**裁定內容**：Demo 期間**不設定** `MAX_ACCESS_KEY`／`MAX_SECRET_KEY`，Trade_Endpoint 恆走 Mock 引擎，零真實資金風險；但仍需 Demo_Auth_Token 認證。Token 於每次 Demo_Server 啟動時重新產生、僅存於行程記憶體、不寫入任何檔案，由伺服器在回應 `index.html` 時注入前端。有效期限即為該次行程生命週期，重啟即更換。

**理由**：無真實資金風險是最省成本的風險消除方式；但若不做認證，第三方網站仍可偽造下單紀錄與 Mock 訂單，在 Demo 畫面上造成不實成交記錄。啟動時產生的一次性 token 不需額外儲存設施，也不會被誤 commit。

**影響**：需求 1.1、1.2、1.6、1.7、1.8、需求 3.5。

### Q2：CORS 處置 — 裁定：選項 2b（完全移除 CORS 標頭）

**裁定內容**：THE Demo_Server 不在任何回應中輸出 `Access-Control-Allow-Origin`、`Access-Control-Allow-Methods`、`Access-Control-Allow-Headers`，並移除 `do_OPTIONS` 對 `/api/*` 的 CORS 預檢回應。前端全部使用相對路徑，同源請求不需 CORS。

**理由**：最嚴格且成本最低——前端既已同源，CORS 標頭純屬多餘的攻擊面。

**Origin 檢查的定位**：Trade_Endpoint 仍比對 `Origin` 標頭（不等於 `http://127.0.0.1:8080` 或 `http://localhost:8080` 即回 403），但此為**深度防禦第二層**。`Origin` 由瀏覽器填寫，可防跨站 JavaScript，不防 curl 等非瀏覽器工具，**主要防護仍為 Demo_Auth_Token**。

**影響**：需求 1.3、1.4、1.5、2.7、2.8。

### Q3：Proxy_Endpoint 白名單粒度 — 裁定：前綴列舉，四個允許值

**裁定內容**：白名單為 `/api/v2/k`、`/api/v2/depth`、`/api/v2/tickers`、`/api/v2/tickers/{market}`（`market` 僅允許 `^[a-z0-9]{3,20}$`）。

**理由**：已實際核對 `web/app.js`，前端確實使用四種路徑，不只 `tickers`：`fetchMaxKlineData` 用 `/api/v2/k`、盤口深度用 `/api/v2/depth`、全幣種列表用 `/api/v2/tickers`、單一幣種即時價用 `/api/v2/tickers/{market}`。前綴列舉可在不改碼的前提下支援新幣種，同時仍封住 SSRF。

**風險提示**：白名單若遺漏任一項會使 K 線圖、盤口委託或行情列表功能失效。

**影響**：需求 2.1、2.2。

### Q4：不可用狀態的畫面呈現 — 裁定：沿用 `--` 並區分兩種不可用

**裁定內容**：數值位置顯示 `--`（沿用既有 PRICE_UNAVAILABLE 慣例）；顯示上次成功取得的時間戳；提供重試操作；「報價不可用」與「AI 分析不可用」須有可區分的文案與圖示。

**理由**：兩種不可用的使用者處理動作不同——報價不可用時等待或換幣種即可；AI 分析不可用需檢查 AWS 憑證與 modelId。若共用同一套文案，主講者無法在台上判斷該做什麼。

**影響**：需求 8.4、8.5、12.5、13.4。

### Q5：Bedrock modelId 的正確值 — 裁定：以實測為準

**裁定內容**：權威版本 Baseline_Spec 記載**經實測可成功呼叫**的 modelId；Demo_Server 啟動時對設定的 modelId 執行一次連通性驗證，失敗時於終端輸出 modelId 與失敗原因。

**現況與風險（已核對）**：生產程式 `start_demo.py` 有**五處** `invoke_model` 使用 `us.anthropic.claude-sonnet-4-6`，缺少日期與版本後綴；專案內測試腳本 `test_invoke.py` 與 `test_model.py` 使用的是完整格式 `us.anthropic.claude-sonnet-4-5-20250929-v1:0`。前者很可能拋 `ValidationException`，導致四位 Agent 全部落入失敗分支，正是需求 12 描述的假共識情境。**此項須於 Demo 前實測確認。**

**影響**：需求 9.6、12.7。

### Q6：Legacy_Java_Server 的處置 — 裁定：移除

**裁定內容**：移除 `src/main/java/api/ServerApp.java`，一併移除 `pom.xml` 中僅供該檔使用的依賴，並更新 Baseline_Spec 中的備援實作敘述。

**理由**：三個選項中移除成本最低。該檔未被 `start_demo.py` 啟動，屬孤島程式碼；保留則需持續維護契約說明與移除假數字，成本最高而效益為零。紅線 1 亦禁止兩份實作同時佔用 8080。

**影響**：需求 14.1 至 14.5（已改寫為移除路徑，不留未裁定分支）。

## 附註

- 本文件僅為需求階段產出，不含設計與實作方式。
- 所有修正皆須在 `.kiro/steering/guardrails.md` 四條紅線內完成；若某項需求看似與紅線衝突，以紅線為準並回報 System Integrator。
- Q5 的 modelId 實測為 Demo 前必辦事項；未完成實測前，需求 12 的假共識風險仍然存在。
