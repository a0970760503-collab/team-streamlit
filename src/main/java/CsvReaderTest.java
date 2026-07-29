import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

public class CsvReaderTest {
    public static void main(String[] args) {
        String filePath = "MaiCoin_最近一年份出入金及交易紀錄.csv";

        try {
            System.out.println("📂 準備讀取 CSV 檔案...");
            // 1. 將檔案的每一行讀進一個 List 裡面
            List<String> lines = Files.readAllLines(Path.of(filePath));
            
            // 2. 略過第 0 行的標題，印出前 5 筆交易紀錄來測試
            for (int i = 1; i <= 5; i++) {
                String line = lines.get(i);
                // 3. CSV 是用逗號分隔的，我們用 split(",") 把每個欄位切開
                String[] columns = line.split(",");
                
                String timestamp = columns[0];
                String currency = columns[1];
                String action = columns[3];
                String change = columns[4];

                System.out.println("幣種: " + currency + " | 動作: " + action + " | 變動: " + change);
            }
            System.out.println("✅ CSV 讀取大成功！");
        } catch (Exception e) {
            System.out.println("❌ 讀取失敗，請確認檔名與路徑是否正確：" + e.getMessage());
        }
    }
}