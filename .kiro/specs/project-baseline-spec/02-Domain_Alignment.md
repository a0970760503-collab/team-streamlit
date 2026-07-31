# 競賽與團隊對齊報告 (Domain Alignment Report)

**狀態**: 已核實與對齊
**目標**: 確保開發方向完全符合「2026 雲湧智生：臺灣生成式 AI 應用黑客松競賽」與「MaiCoin 企業命題」之評分標準與 AWS 合規要求。

## 1. 團隊架構與角色理解
- **System Integrator**: 系統總整合、單點啟動管線設計、前後端 REST API 串接、開發紅線與防呆機制制定。
- **Backend Engineer**: Java 備援後端服務、MAX API 封裝 (MaxApiManager)、Agent 演算法與技術指標實作。
- **Data Analyst**: R 語言數據管線、出入金 CSV 特徵萃取、投資人格模型 (update_agent_report.R)。
- **Frontend UI/UX**: 原生 SVG 前端面板設計、K 線與盤口渲染、零依賴架構實作。
- **Project Manager**: 競賽簡報大綱、商業模式、提案規劃與 User Flow 設計。

## 2. 產品核心價值與 Demo 目標
- **核心口號**: 「AI 不只理解市場，更理解你」
- **亮點與 User Flow**:
  1. 讀取真實歷史交易 (CSV) 進行投資人格判定 (如高頻、波段、保守)。
  2. 4 大 Agent (技術面、籌碼面、風控面、行為面) 基於人格特徵與 MAX 實時報價進行加權辯論。
  3. AI 委員會動態決策 (BUY/HOLD/SELL) 並輸出信心分數。
  4. 一鍵跟單 (雙向數據流)，透過 `/api/trade` 回傳 MAX 模擬訂單，完美呼應命題對「雙向數據流」的最高評分要求。

## 3. AWS 官方紅線與工具清單
開發過程中已嚴格確保以下 AWS 合規限制：
- **Amazon Bedrock**: API 呼叫上限嚴格限制為 1 RPS。已規劃佇列 (Queue) 序列化執行，嚴禁 Agent 併發請求。
- **儲存與運算安全**:
  - S3 Bucket 必須關閉公開存取 (Block Public Access)。
  - EC2 Security Group 禁止 0.0.0.0/0 全開。
  - EC2 不提供 GPU 實例，禁止本地部署 LLM，必須完全依賴 Amazon Bedrock 進行推論。
- **資安防護**: `.env` 已設定嚴格隔離，禁止任何 API Key 或 Access Key 上傳至 GitHub。

## 4. 決議與後續行動
R 管線的 `httr` 與 `jsonlite` 依賴已於本地安裝並跑通，不再依賴 Mock Data。
後續串接 Bedrock 時，將以 Python 實作 1 RPS 的速率限制器 (Rate Limiter)，確保 Agent 辯論模組不會觸發 ThrottlingException。
