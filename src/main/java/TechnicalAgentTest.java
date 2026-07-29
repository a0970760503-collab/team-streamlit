

import org.ta4j.core.BarSeries;
import org.ta4j.core.BaseBarSeriesBuilder;
import org.ta4j.core.indicators.RSIIndicator;
import org.ta4j.core.indicators.helpers.ClosePriceIndicator;

import java.time.ZonedDateTime;

public class TechnicalAgentTest {
    public static void main(String[] args) {
        System.out.println("🤖 Technical Agent 啟動！開始計算技術指標...");

        // 1. 建立一個 K 線序列容器 (就像一個能裝載 K 線的陣列)
        BarSeries series = new BaseBarSeriesBuilder().withName("BTC_KLine").build();

        // 2. 模擬加入我們剛剛從 MAX API 抓到的 K 線資料
        // addBar 參數順序：(時間, 開盤價, 最高價, 最低價, 收盤價, 交易量)
        ZonedDateTime now = ZonedDateTime.now();
        series.addBar(now.minusMinutes(4), 2058000, 2095000, 2036363, 2050000, 21.9);
        series.addBar(now.minusMinutes(3), 2050000, 2060000, 2045000, 2055000, 15.2);
        series.addBar(now.minusMinutes(2), 2055000, 2070000, 2050000, 2065000, 18.5);
        series.addBar(now.minusMinutes(1), 2065000, 2090000, 2060000, 2087459, 20.1);

        // 3. 設定指標：抓出「收盤價」，然後計算「RSI」
        ClosePriceIndicator closePrice = new ClosePriceIndicator(series);
        
        // 因為測試資料只有 4 筆，我們把 RSI 週期設為 3 (實戰中通常設定為 14)
        RSIIndicator rsi = new RSIIndicator(closePrice, 3);

        // 4. 印出最新一筆 K 線的 RSI 數值！
        double currentRSI = rsi.getValue(series.getEndIndex()).doubleValue();
        System.out.println("📊 最新 K 線的 RSI 數值為：" + currentRSI);

        // 5. Technical Agent 趨勢判斷邏輯
        System.out.println("=====================================");
        if (currentRSI > 70) {
            System.out.println("💡 Agent 決策：目前市場過熱 (超買)，建議【賣出 / 觀望】。");
        } else if (currentRSI < 30) {
            System.out.println("💡 Agent 決策：目前市場恐慌 (超賣)，建議【買進】。");
        } else {
            System.out.println("💡 Agent 決策：目前市場情緒中性，建議【HOLD】。");
        }
    }
}