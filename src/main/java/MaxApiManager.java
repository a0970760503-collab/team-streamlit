import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

public class MaxApiManager {

    // 建立一個共用的 HttpClient，不用每次抓資料都重新建立
    private static final HttpClient client = HttpClient.newHttpClient();
    
    // MAX API 的基礎網址
    private static final String BASE_URL = "https://max-api.maicoin.com/api/v2";

    // 1. 取得行情與交易量 (Ticker)
    // Ticker 的回傳值本身就包含了開高低收，以及 "vol" (24小時交易量)
    public static void getTicker(String market) {
        String url = BASE_URL + "/tickers/" + market;
        System.out.println("\n📊 [1. 行情與交易量] 網址：" + url);
        sendRequest(url);
    }

    // 2. 取得 K 線圖 (K-Line)
    // period=1 代表 1 分鐘線，limit=3 代表只抓最新 3 根 K 線來測試
    public static void getKLine(String market) {
        String url = BASE_URL + "/k?market=" + market + "&limit=3&period=1";
        System.out.println("\n📈 [2. K 線圖] 網址：" + url);
        sendRequest(url);
    }

    // 3. 取得深度圖 (Depth)
    // 掛單簿的買賣狀況 (asks 是賣單, bids 是買單)。limit=2 代表只看最接近市價的前 2 檔
    public static void getDepth(String market) {
        String url = BASE_URL + "/depth?market=" + market + "&limit=2";
        System.out.println("\n🌊 [3. 深度圖] 網址：" + url);
        sendRequest(url);
    }

    // 4. 取得最新成交紀錄 (Trades)
    // 雖然 Ticker 有總交易量，但如果需要更細緻的市場動能，可以抓即時成交的單
    public static void getTrades(String market) {
        String url = BASE_URL + "/trades?market=" + market + "&limit=3";
        System.out.println("\n💰 [4. 最新成交紀錄] 網址：" + url);
        sendRequest(url);
    }

    // --- 核心工具：負責去幫你敲門拿資料的方法 ---
    private static void sendRequest(String url) {
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .GET()
                    .build();

            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());

            if (response.statusCode() == 200) {
                System.out.println(response.body()); // 印出成功抓到的 JSON
            } else {
                System.out.println("❌ 抓取失敗，狀態碼：" + response.statusCode());
            }
        } catch (Exception e) {
            System.out.println("❌ 發生錯誤：" + e.getMessage());
        }
    }

    // --- 主程式：執行點 ---
    public static void main(String[] args) {
        String targetCoin = "btctwd"; // 設定我們要觀察的交易對：比特幣對台幣

        System.out.println("啟動 MAX API 資料抓取測試...");
        
        // 依序呼叫四個功能
        getTicker(targetCoin);
        getKLine(targetCoin);
        getDepth(targetCoin);
        getTrades(targetCoin);
    }
}