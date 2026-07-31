[English](#english) | [繁體中文](#繁體中文)

# English

# AI Investment Committee (AI 投資委員會)

A fully integrated trading terminal and automated analysis engine. This system aggregates user transaction history to build a personalized risk profile, leverages multiple AI agents (Technical, Risk, Sentiment, Behavior) to debate market conditions, and executes dynamic weighted voting to recommend trading strategies. It includes a complete frontend interface with interactive K-line charts, real-time order books, and one-click execution capabilities via the MAX Exchange API.

## System Features

### Core Mechanics
- **Multi-Agent Architecture**: 4 specialized AI agents process market data and output weighted trading decisions (BUY/HOLD/SELL).
- **Personalized Risk Modeling**: R-based data pipeline for extracting user trading habits and risk tolerance from CSV transaction logs.
- **End-to-End Execution**: Secure order execution engine with payload signing and dynamic asset updates via the MAX Exchange API.

### Interface & Graphics
- **Real-Time Market Data**: Live integration with MAX API for Ticker and Depth (Orderbook).
- **Interactive Technical Charts**: Native SVG-based rendering with interactive crosshairs and multi-period timeframes, supporting magnetic price snapping.
- **Real-Time Crypto News**: Dynamic integration of authentic RSS feeds (e.g., Cointelegraph) to stream relevant market news, filtering content based on the active trading pair.
- **Cross-Platform PWA**: Progressive Web App support ensuring seamless installation on mobile devices with `100dvh` layout optimizations for a native-like experience on Safari/Chrome.

## Installation & Usage

### Prerequisites
- Python 3.9 or higher
- Java 17 or higher (Spring Boot 3.x)
- R (with required data processing packages)

### Initialization

The repository includes an orchestration script that automates the backend API server and opens the web client.

1. Clone the repository and navigate to the root directory.
2. Rename `.env.example` to `.env` and fill in your API keys.
3. Ensure you have the necessary dependencies installed for both Python and Java.
4. Execute the binary via terminal or command prompt:
   ```bash
   python start_demo.py
   ```

This script will automatically:
- Execute `scripts/update_agent_report.R` to parse historical data.
- Spin up the Java Spring Boot REST API server on `http://localhost:8080`.
- Launch the `web/index.html` frontend interface in your default browser.
- Establish the CORS proxy for live MAX Exchange data.

To safely stop all services, press `Ctrl + C` in the terminal.

### Usage Instructions

1. **Select Market**: Use the left sidebar to select your desired trading pair (e.g., BTCUSDT). The interactive K-line chart and real-time Orderbook will update automatically.
3. **AI Committee Debate**: Click the floating chat button on the bottom right and toggle the **召開委員會 (Convene Committee)** switch. Enter a prompt like "Analyze BTC for me" to trigger the multi-agent debate engine.
4. **Review & Execute**: The AI agents will output a weighted consensus (BUY/HOLD/SELL). If you agree with the recommendation, use the trading panel to adjust your volume and execute the trade with one click.

### Software Architecture
- **Frontend**: Vanilla JS / HTML / CSS
- **Backend API**: `GET /api/report` (Decision generation), `POST /api/trade` (Order execution).
- **Internal Proxy**: Routes MAX API requests via `http://localhost:8080/api/proxy` to bypass CORS constraints.

*Disclaimer: This is a prototype system. Please do not use it with real API keys holding significant funds without proper security audits.*

---
<br>
<br>

# 繁體中文

# AI 投資委員會 (AI Investment Committee)

一套完整整合的交易終端機與自動化分析引擎。本系統透過解析使用者的歷史交易紀錄來建立個人化的風險模型，並結合多重 AI 代理人 (技術分析、風險控制、市場情緒、行為分析) 針對市場現況進行辯論，最終透過動態權重投票產出交易策略建議。系統內建完整的前端介面，提供互動式 K 線圖、即時盤口深度，並支援透過 MAX 交易所 API 進行一鍵下單。

## 系統特色

### 核心機制
- **多代理人架構 (Multi-Agent)**：4 位專精不同領域的 AI 代理人負責處理市場數據，並產出帶有權重的交易決策 (買進/持有/賣出)。
- **個人化風險模型**：基於 R 語言建構的數據管線，負責從歷史 CSV 交易紀錄中萃取出使用者的交易習慣與風險承受度。
- **端到端交易執行**：具備安全雜湊簽章的訂單執行引擎，可透過 MAX 交易所 API 即時更新資產並完成真實交易。

### 介面與圖表
- **即時市場數據**：與 MAX API 實時對接，即時更新 Ticker 報價與 Orderbook 盤口深度。
- **互動式技術圖表**：使用原生 SVG 渲染 K 線圖，支援多週期切換與互動式十字游標 (具備收盤價磁吸功能)。
- **即時加密貨幣新聞**：動態串接真實 RSS 新聞源 (如 Cointelegraph)，並根據當前觀看的幣種進行智慧過濾，提供最即時的市場脈動。
- **跨平台 PWA 支援**：支援漸進式網頁應用程式 (PWA) 安裝，並針對 Safari/Chrome 行動版瀏覽器導入 `100dvh` 排版優化，提供媲美原生 APP 的無縫體驗。

## 安裝與執行

### 環境要求
- Python 3.9 或以上版本
- Java 17 或以上版本 (Spring Boot 3.x)
- R (需安裝對應之數據處理套件)

### 啟動專案

本專案內建自動化總控腳本，可一鍵啟動後端 API 伺服器並開啟網頁客戶端。

1. 複製 (Clone) 此儲存庫並進入專案根目錄。
2. 將專案中的 `.env.example` 重新命名為 `.env`，並打開填寫您的 API 金鑰。
3. 確保您的系統已安裝 Python 與 Java 的相關依賴環境。
4. 在終端機或命令提示字元執行以下指令：
   ```bash
   python start_demo.py
   ```

該腳本將會自動執行以下流程：
- 呼叫 `scripts/update_agent_report.R` 解析歷史交易數據。
- 於 `http://localhost:8080` 啟動 Java Spring Boot REST API 伺服器。
- 在預設瀏覽器中開啟 `web/index.html` 前端介面。
- 建立解決 CORS 限制的本地端 API Proxy 轉發服務。

欲安全關閉所有服務，請在終端機按下 `Ctrl + C`。

### 使用教學 (Step-by-Step Guide)

1. **選擇交易對**：在左側選單點擊您感興趣的幣種 (例如 BTCUSDT)。中央的互動式 K 線圖與盤口深度將會立刻同步即時數據。
3. **召開 AI 委員會**：點擊右下角的聊天室按鈕，並開啟 **召開委員會** 開關。在對話框輸入例如「幫我分析目前的 BTC 局勢」，即可觸發 4 位專精不同領域的 AI 代理人進行深度辯論。
4. **一鍵下單**：AI 將根據辯論結果給出最終建議 (買進/持有/賣出)。若您同意該策略，可直接在交易面板調整數量，並點擊按鈕完成自動化一鍵下單。

### 軟體架構
- **前端 (Frontend)**：Vanilla JS / HTML / CSS (無須額外建置框架)
- **後端 (Backend API)**：`GET /api/report` (生成決策與報告)、`POST /api/trade` (執行下單)。
- **內部代理 (Internal Proxy)**：經由 `http://localhost:8080/api/proxy` 轉發 MAX API 請求，突破前端 CORS 跨網域限制。

*免責聲明：本專案為原型測試系統。在未經完善資安稽核前，請勿綁定存有大額資金之真實 API 金鑰。*