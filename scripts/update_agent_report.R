# =====================================================================
# AI Investment Committee - Agent Report Updater
# 路徑由腳本自身位置推導，可從任何 cwd 執行
# =====================================================================

args_all <- commandArgs(trailingOnly = FALSE)
file_arg <- sub("^--file=", "", args_all[grep("^--file=", args_all)])
script_dir <- if (length(file_arg) > 0) dirname(normalizePath(file_arg)) else getwd()
PROJECT_ROOT <- normalizePath(file.path(script_dir, ".."))

# 路徑常數（data/ 位於 team-streamlit 之外的工作區根目錄）
REPORT_PATH <- file.path(PROJECT_ROOT, "web", "agent_report.json")
CSV_PATH    <- file.path(PROJECT_ROOT, "..", "data", "MaiCoin_最近一年份出入金及交易紀錄.csv")
ENV_PATH    <- file.path(PROJECT_ROOT, ".env")

# 金鑰改由 .env 載入，不得寫死在原始碼
if (file.exists(ENV_PATH)) readRenviron(ENV_PATH)
CMC_API_KEY <- Sys.getenv("CMC_API_KEY")
if (nchar(CMC_API_KEY) == 0) {
  stop("CMC_API_KEY 未設定。請複製 .env.example 為 .env 並填入 CoinMarketCap API Key。")
}

library(httr)
library(jsonlite)
library(TTR)

# MAX API Technical Agent

res_max <- GET(
  "https://max-api.maicoin.com/api/v3/k",
  query = list(
    market = "soltwd",
    limit = 100,
    period = 60
  )
)

kline <- fromJSON(
  content(res_max, "text")
)

kline <- as.data.frame(kline)

colnames(kline) <- c(
  "timestamp",
  "open",
  "high",
  "low",
  "close",
  "volume"
)

kline$close <- as.numeric(kline$close)

kline$rsi <- RSI(kline$close)

latest_rsi <- tail(
  na.omit(kline$rsi),
  1
)

print(latest_rsi)

kline$ma5 <- SMA(
  kline$close,
  n = 5
)

kline$ma20 <- SMA(
  kline$close,
  n = 20
)

latest_ma5 <- tail(
  na.omit(kline$ma5),
  1
)

latest_ma20 <- tail(
  na.omit(kline$ma20),
  1
)

if(latest_rsi > 70){

  signal <- "SELL"

} else if(latest_rsi < 30){

  signal <- "BUY"

} else {

  signal <- "HOLD"

}

technical_score <- round(latest_rsi)

# CoinMarketCap API
res <- GET(
  "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest",
  add_headers(
    "X-CMC_PRO_API_KEY" = CMC_API_KEY
  )
)

result <- fromJSON(content(res,"text"))

sol <- result$data[
  result$data$symbol == "SOL",
]

# Market Agent
market_agent <- list(
  coin = "SOL",
  rank = sol$cmc_rank,
  price_usd = round(sol$quote$USD$price,2),
  market_cap = round(sol$quote$USD$market_cap,0),
  volume_24h = round(sol$quote$USD$volume_24h,0),
  change_24h = round(sol$quote$USD$percent_change_24h,2)
)

# Sentiment Agent

# Fear & Greed API

fg_res <- GET(
  "https://pro-api.coinmarketcap.com/v3/fear-and-greed/latest",
  add_headers(
    "X-CMC_PRO_API_KEY" = CMC_API_KEY
  )
)

fg_result <- fromJSON(
  content(
    fg_res,
    "text",
    encoding = "UTF-8"
  )
)

fear_greed <- as.numeric(
  fg_result$data$value
)

fear_classification <-
  fg_result$data$value_classification

if(fear_greed >= 70){

  fg_score <- 80

}else if(fear_greed <= 30){

  fg_score <- 20

}else{

  fg_score <- 50

}

trending_coin <- "SOL"

change24h <- sol$quote$USD$percent_change_24h

if(change24h > 5){

  price_score <- 80

}else if(change24h < -5){

  price_score <- 20

}else{

  price_score <- 50

}

sentiment_score <- round(

  price_score * 0.5 +

  fg_score * 0.5

)

if(sentiment_score >= 70){

  sentiment <- "Bullish"

}else if(sentiment_score <= 30){

  sentiment <- "Bearish"

}else{

  sentiment <- "Neutral"

}

sentiment_agent <- list(

  sentiment_score = sentiment_score,

  sentiment = sentiment,

  source = "CoinMarketCap",

  change_24h = round(change24h,2),

  fear_greed = fear_greed,

  fear_greed_classification =
    fear_classification

)

# 讀取既有 JSON（首次執行時檔案可能尚未存在）

agent_report <- if (file.exists(REPORT_PATH)) {
  read_json(REPORT_PATH, simplifyVector = TRUE)
} else {
  list()
}

if (!file.exists(CSV_PATH)) stop(paste("找不到交易紀錄 CSV：", CSV_PATH))

trade <- read.csv(
  CSV_PATH,
  fileEncoding = "UTF-8",
  stringsAsFactors = FALSE
)

trade_coin <- subset(
  trade,
  action %in% c("buy","sell")
)

favorite_coin <- names(
  sort(
    table(trade_coin$currency),
    decreasing = TRUE
  )
)[1]

print(favorite_coin)

trade_count <- nrow(trade_coin)

print(trade_count)

if(trade_count >= 3000){

  personality <- "高頻交易型"

}else if(trade_count >= 1000){

  personality <- "短線型"

}else if(trade_count >= 300){

  personality <- "波段型"

}else{

  personality <- "保守型"

}

if(personality == "保守型"){

  risk_score <- 30

}else if(personality == "波段型"){

  risk_score <- 60

}else if(personality == "短線型"){

  risk_score <- 80

}else{

  risk_score <- 90

}

print(risk_score)

print(personality)

# Risk Agent Score（風險越低分數越高）

risk_agent_score <- 100 - risk_score

# Behavior Agent Score
# 以移動平均成本法逐幣種追蹤持倉，計算已實現平倉勝率（base R）

trade_hist <- trade_coin
trade_hist$price     <- as.numeric(trade_hist$price)
trade_hist$change    <- as.numeric(trade_hist$change)
trade_hist$timestamp <- as.numeric(trade_hist$timestamp)
trade_hist <- trade_hist[order(trade_hist$timestamp), ]

holding_qty   <- list()
avg_cost      <- list()
closed_trades <- 0
win_trades    <- 0

for (i in seq_len(nrow(trade_hist))) {

  coin <- as.character(trade_hist$currency[i])
  act  <- as.character(trade_hist$action[i])
  px   <- trade_hist$price[i]
  qty  <- abs(trade_hist$change[i])

  if (!(coin %in% names(holding_qty))) {
    holding_qty[[coin]] <- 0
    avg_cost[[coin]]    <- 0
  }

  if (is.na(px) || is.na(qty)) next

  if (act == "buy") {

    total_qty <- holding_qty[[coin]] + qty

    if (total_qty > 0) {
      avg_cost[[coin]] <-
        (avg_cost[[coin]] * holding_qty[[coin]] + px * qty) / total_qty
    }

    holding_qty[[coin]] <- total_qty

  } else if (act == "sell") {

    if (avg_cost[[coin]] > 0) {

      realized <- (px - avg_cost[[coin]]) * qty

      closed_trades <- closed_trades + 1

      if (realized > 0) win_trades <- win_trades + 1
    }

    holding_qty[[coin]] <- max(0, holding_qty[[coin]] - qty)
  }
}

win_rate <- if (closed_trades > 0) win_trades / closed_trades else 0.5

behavior_agent_score <- round(win_rate * 100)

print(win_rate)

print(behavior_agent_score)

agent_report <- agent_report[
  !names(agent_report) %in% c("1","2","3","4")
]

# 更新
agent_report$market_agent <- market_agent
agent_report$sentiment_agent <- sentiment_agent

# Technical Score

technical_score <- round(latest_rsi)

# Sentiment Score

sentiment_agent_score <- sentiment_score

# Investment Committee

committee_score <-
  technical_score * 0.4 +
  sentiment_agent_score * 0.2 +
  risk_agent_score * 0.2 +
  behavior_agent_score * 0.2

  ## Chairman Input

chairman_input <- list(

  technical_agent = list(
    score = technical_score,
    rsi = round(latest_rsi,2),
    ma5 = round(latest_ma5,2),
    ma20 = round(latest_ma20,2),
    signal = signal
  ),

  sentiment_agent = list(
    score = sentiment_agent_score,
    sentiment = sentiment,
    fear_greed = fear_greed
  ),

  risk_agent = list(
    score = risk_agent_score
  ),

  behavior_agent = list(
    score = behavior_agent_score
  ),

  committee_score = round(committee_score,2)
)

# Final Action
# if(committee_score >= 70){
#   final_action <- "BUY"
# } else if(committee_score <= 40){
#   final_action <- "SELL"
# } else {
#   final_action <- "HOLD"
# }


# 更新 Technical Agent

agent_report$technical_agent <- list(

  coin = "SOL",

  rsi = round(latest_rsi,2),

  ma5 = round(latest_ma5,2),

  ma20 = round(latest_ma20,2),

  signal = signal

)

# 更新 Investment Committee


agent_report$investment_committee <- list(
  technical_score = technical_score,
  sentiment_score = sentiment_agent_score,
  risk_score = risk_agent_score,
  behavior_score = behavior_agent_score,
  committee_score = round(committee_score,2)
)

agent_report$chairman_input <- chairman_input

agent_report$user_profile <- list(
  personality = personality,
  favorite_coin = favorite_coin,
  risk_score = risk_score,
  win_rate = round(win_rate,4)
)

agent_report$chairman_prompt <- paste(
  "你是AI投資委員會主席。",
  "請根據以下Agent分析結果做出最終投資決策。",
  "Technical Score:", technical_score,
  "Sentiment Score:", sentiment_agent_score,
  "Risk Score:", risk_agent_score,
  "Behavior Score:", behavior_agent_score,
  "Committee Score:", round(committee_score,2)
)

# 更新 Recommendation

agent_report$recommendation <- list(

  confidence = round(committee_score,0),

  summary =
    paste(
      "SOL RSI",
      round(latest_rsi,2),
      "市場情緒",
      sentiment,
      "Committee Score",
      round(committee_score,2)
    )

)

agent_report$llm_input <- list(

  personality =
    personality,

  favorite_coin =
    favorite_coin,

  market_rank =
    market_agent$rank,

  price_usd =
    market_agent$price_usd,

  risk_score =
    risk_score,
  
  rsi =
    round(latest_rsi,2),

  ma5 =
    round(latest_ma5,2),

  ma20 =
    round(latest_ma20,2),

  signal =
    signal,

  change_24h =
    round(change24h,2),

  fear_greed =
    fear_greed,

  fear_greed_classification =
    fear_classification,

  sentiment =
    sentiment,

  committee_score =
    round(committee_score,2),

  updated_time =
    format(
      Sys.time(),
      "%Y-%m-%d %H:%M:%S"
    )

)

agent_report$updated_time <- format(
  Sys.time(),
  "%Y-%m-%d %H:%M:%S"
)

# 寫回
write_json(
  agent_report,
  REPORT_PATH,
  pretty = TRUE,
  auto_unbox = TRUE
)

print("Agent Report Updated")
