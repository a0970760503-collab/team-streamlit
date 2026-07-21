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

write_json(
  agent_report,
  "output/agent_report.json",
  pretty = TRUE,
  auto_unbox = TRUE
)

# CoinMarketCap API
res <- GET(
  "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest",
  add_headers(
    "X-CMC_PRO_API_KEY" = "833496923b49438ab17bea657a023635"
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
    "X-CMC_PRO_API_KEY" = "833496923b49438ab17bea657a023635"
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

# 讀取既有 JSON

agent_report <- read_json(
  "output/agent_report.json",
  simplifyVector = TRUE
)

# 更新
agent_report$market_agent <- market_agent
agent_report$sentiment_agent <- sentiment_agent

# Technical Score

technical_score <- round(latest_rsi)

# 固定分數

risk_agent_score <- 42.07

behavior_agent_score <- 60

# Sentiment Score

sentiment_agent_score <- sentiment_score

# Investment Committee

committee_score <-
  technical_score * 0.4 +
  sentiment_agent_score * 0.2 +
  risk_agent_score * 0.2 +
  behavior_agent_score * 0.2

# Final Action

if(committee_score >= 70){

  final_action <- "BUY"

} else if(committee_score <= 40){

  final_action <- "SELL"

} else {

  final_action <- "HOLD"

}

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

  committee_score = round(committee_score,2),

  final_action = final_action

)

# 更新 Recommendation

agent_report$recommendation <- list(

  action = final_action,

  confidence = round(committee_score,0),

  summary =
    paste(
      "SOL RSI",
      round(latest_rsi,2),
      "市場情緒",
      sentiment,
      "投資委員會建議",
      final_action
    )

)

agent_report$llm_input <- list(

  personality =
    agent_report$user_profile$personality,

  favorite_coin =
    agent_report$user_profile$favorite_coin,

  market_rank =
    market_agent$rank,

  price_usd =
    market_agent$price_usd,

  risk_score =
    agent_report$risk_agent$risk_score,

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

  final_action =
    final_action,

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
  "output/agent_report.json",
  pretty = TRUE,
  auto_unbox = TRUE
)

print("Agent Report Updated")