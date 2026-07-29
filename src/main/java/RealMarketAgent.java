import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import com.google.gson.Gson;
import org.ta4j.core.BarSeries;
import org.ta4j.core.BaseBarSeriesBuilder;
import org.ta4j.core.indicators.RSIIndicator;
import org.ta4j.core.indicators.helpers.ClosePriceIndicator;
// 👇 這次新加入的武器：均線 (SMA) 與 MACD
import org.ta4j.core.indicators.SMAIndicator;
import org.ta4j.core.indicators.MACDIndicator;

public class RealMarketAgent {
    public static void main(String[] args) {
        try {
            System.out.println("🌐 [1/4] 正在連線 MAX 交易所，抓取真實比特幣最新 K 線...");
            
            // 抓最近 30 筆的 15 分鐘線
            String url = "https://max-api.maicoin.com/api/v2/k?market=btctwd&limit=30&period=15";
            HttpClient client = HttpClient.newHttpClient();
            HttpRequest request = HttpRequest.newBuilder().uri(URI.create(url)).GET().build();
            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());

            System.out.println("✅ [2/4] 資料抓取成功！正在將 JSON 轉換為 Java 陣列...");
            Gson gson = new Gson();
            double[][] klines = gson.fromJson(response.body(), double[][].class);

            System.out.println("🧠 [3/4] 將真實報價餵給 Technical Agent，計算多重技術指標...");
            BarSeries series = new BaseBarSeriesBuilder().withName("Real_BTC").build();

            for (double[] k : klines) {
                long timestamp = (long) k[0];
                ZonedDateTime time = ZonedDateTime.ofInstant(Instant.ofEpochSecond(timestamp), ZoneId.systemDefault());
                series.addBar(time, k[1], k[2], k[3], k[4], k[5]); // 開、高、低、收、量
            }

            // ================= 核心計算區 =================
            // 1. 抓出收盤價 (所有指標的基礎)
            ClosePriceIndicator closePrice = new ClosePriceIndicator(series);
            double currentPrice = closePrice.getValue(series.getEndIndex()).doubleValue();
            
            // 2. 計算 RSI (14期)
            RSIIndicator rsi = new RSIIndicator(closePrice, 14);
            double currentRSI = rsi.getValue(series.getEndIndex()).doubleValue();

            // 3. 計算 SMA 均線 (設定為 5 期短線趨勢)
            SMAIndicator sma = new SMAIndicator(closePrice, 5);
            double currentSMA = sma.getValue(series.getEndIndex()).doubleValue();

            // 4. 計算 MACD (業界標準參數 12, 26)
            MACDIndicator macd = new MACDIndicator(closePrice, 12, 26);
            double currentMACD = macd.getValue(series.getEndIndex()).doubleValue();

            // ================= 終端機輸出與決策區 =================
            System.out.println("=================================================");
            System.out.printf("💰 最新收盤價格：%.2f\n", currentPrice);
            System.out.printf("📊 RSI  相對強弱：%.2f\n", currentRSI);
            System.out.printf("📈 SMA  5期均線 ：%.2f\n", currentSMA);
            System.out.printf("📉 MACD 動能指標：%.2f\n", currentMACD);
            System.out.println("=================================================");
            
            // Agent 綜合趨勢判斷 (結合 RSI, 均線, MACD)
            if (currentRSI > 70 || (currentMACD < 0 && currentPrice < currentSMA)) {
                // RSI過高，或是 (MACD小於0 且 跌破均線) -> 看空
                System.out.println("💡 AI 綜合決策：多項指標顯示市場過熱或轉弱，建議【賣出 / 觀望】。");
            } else if (currentRSI < 30 || (currentMACD > 0 && currentPrice > currentSMA)) {
                // RSI過低，或是 (MACD大於0 且 突破均線) -> 看多
                System.out.println("💡 AI 綜合決策：多項指標顯示市場超賣或轉強，建議【買進】。");
            } else {
                System.out.println("💡 AI 綜合決策：目前市場多空不明，建議【HOLD】。");
            }
            System.out.println("=================================================");

        } catch (Exception e) {
            System.out.println("❌ 發生錯誤：" + e.getMessage());
        }
    }
}