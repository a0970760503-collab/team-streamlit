import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import com.google.gson.Gson;
import java.util.ArrayList;
import java.util.List;

public class RiskAgent {
    public static void main(String[] args) {
        try {
            System.out.println("🛡️ [1/3] 啟動 Risk Agent... 正在從 MAX 抓取近 100 筆 K 線資料...");
            
            // 為了看清風險，我們抓取 100 筆 15 分鐘線來分析歷史軌跡
            String url = "https://max-api.maicoin.com/api/v2/k?market=btctwd&limit=100&period=15";
            HttpClient client = HttpClient.newHttpClient();
            HttpRequest request = HttpRequest.newBuilder().uri(URI.create(url)).GET().build();
            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());

            // 將 JSON 轉換為 Java 陣列
            Gson gson = new Gson();
            double[][] klines = gson.fromJson(response.body(), double[][].class);

            // 把所有的「收盤價」單獨抽出來，方便做數學運算
            List<Double> closePrices = new ArrayList<>();
            for (double[] k : klines) {
                closePrices.add(k[4]); // 索引 4 是收盤價
            }

            System.out.println("🧮 [2/3] 正在計算歷史最大回撤 (MDD) 與 波動率...");

            // ================= 核心風險邏輯 =================
            
            // 1. 計算最大回撤 (Max Drawdown) - 也就是「如果你買在最高點，最慘會賠多少比例」
            double maxPrice = 0;
            double maxDrawdown = 0;
            for (double price : closePrices) {
                if (price > maxPrice) {
                    maxPrice = price; // 紀錄目前看過的最高價
                }
                double drawdown = (maxPrice - price) / maxPrice; // 算跌幅
                if (drawdown > maxDrawdown) {
                    maxDrawdown = drawdown; // 記錄最慘的跌幅
                }
            }

            // 2. 計算波動率 (平均絕對漲跌幅) - 衡量市場價格跳動的劇烈程度
            double totalVolatility = 0;
            for (int i = 1; i < closePrices.size(); i++) {
                double prev = closePrices.get(i - 1);
                double curr = closePrices.get(i);
                double change = Math.abs((curr - prev) / prev);
                totalVolatility += change;
            }
            double avgVolatility = totalVolatility / (closePrices.size() - 1);

            // 3. 計算綜合風險分數 (0~100)
            // 將回撤與波動率透過加權轉換成直觀的分數 (這裡的權重參數可以依據實戰經驗微調)
            double riskScore = (maxDrawdown * 100 * 5) + (avgVolatility * 100 * 20);
            if (riskScore > 100) riskScore = 100; // 分數封頂 100 分

            // ================= 終端機輸出與決策區 =================
            System.out.println("=================================================");
            System.out.printf("📉 最大回撤率 (MDD)：%.2f%%\n", maxDrawdown * 100);
            System.out.printf("🌪️ 平均波動率：%.2f%%\n", avgVolatility * 100);
            System.out.printf("⚠️ 綜合風險分數：%.0f / 100\n", riskScore);
            System.out.println("=================================================");

            // 4. Agent 風險決策
            if (riskScore > 75) {
                System.out.println("🚨 警報：目前市場處於【極高風險】狀態，不建議新手進場，請嚴格設定停損！");
            } else if (riskScore > 40) {
                System.out.println("⚠️ 提醒：目前市場為【中度風險】，請控制倉位大小，避免重注。");
            } else {
                System.out.println("🟢 安全：目前市場為【低風險】盤整期，適合穩健佈局。");
            }
            System.out.println("=================================================");

        } catch (Exception e) {
            System.out.println("❌ 發生錯誤：" + e.getMessage());
        }
    }
}