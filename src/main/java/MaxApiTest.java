import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

public class MaxApiTest {
    public static void main(String[] args) {
        try {
            // 1. 指定 MAX 交易所的 Public API 網址 (抓取比特幣對台幣的行情)
            String url = "https://max-api.maicoin.com/api/v2/tickers/btctwd";

            // 2. 建立一個負責發送網路請求的客戶端 (HttpClient)
            HttpClient client = HttpClient.newHttpClient();

            // 3. 準備好你的請求單 (HttpRequest)，因為我們只是要「拿」資料，所以用 GET
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(url))
                    .GET() 
                    .build();

            System.out.println("🚀 正在向 MAX 交易所呼叫 API...");

            // 4. 發送請求，並把拿到的結果存起來
            HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());

            // 5. 檢查是不是成功拿到資料 (HTTP 狀態碼 200 代表大成功)
            if (response.statusCode() == 200) {
                System.out.println("✅ 抓取成功！底下是即時行情資料：\n");
                // 印出伺服器回傳的內容 (會是一大串 JSON 格式的字串)
                System.out.println(response.body());
            } else {
                System.out.println("❌ 抓取失敗，伺服器回傳狀態碼：" + response.statusCode());
            }

        } catch (Exception e) {
            System.out.println("❌ 發生錯誤：" + e.getMessage());
        }
    }
}