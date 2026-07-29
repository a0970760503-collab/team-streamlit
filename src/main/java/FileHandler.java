import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

public class FileHandler {

    /**
     * 讀取檔案內容並轉為字串 (用來讀取詠喬產出的 agent_report.json)
     */
    public static String readFile(String filePath) {
        try {
            // 將檔案路徑轉換為 Path 物件，並一次性讀取所有字串
            Path path = Path.of(filePath);
            return Files.readString(path);
        } catch (IOException e) {
            System.err.println("❌ 讀取檔案失敗：" + e.getMessage());
            return null; // 如果讀不到，回傳 null
        }
    }

    /**
     * 將處理完的 JSON 字串回存成新檔案 (用來傳給美妃的前端)
     */
    public static void saveFile(String data, String filePath) {
        try {
            Path path = Path.of(filePath);
            // 寫入檔案。如果檔案不存在會自動建立，如果存在則會覆蓋過去
            Files.writeString(path, data, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
            System.out.println("✅ 檔案已成功儲存至：" + filePath);
        } catch (IOException e) {
            System.err.println("❌ 儲存檔案失敗：" + e.getMessage());
        }
    }

    // --- 以下為測試用的主程式 (Main 方法) ---
    public static void main(String[] args) {
        // 1. 定義測試用的檔案路徑
        String inputFilePath = "agent_report.json"; 
        String outputFilePath = "frontend_data.json";

        // (測試前準備：請先在專案根目錄手動建立一個 agent_report.json，隨便塞一點文字進去)

        // 2. 測試讀取功能
        System.out.println("正在讀取檔案...");
        String content = readFile(inputFilePath);
        
        if (content != null) {
            System.out.println("讀取到的內容為：\n" + content);
            
            // 3. 模擬 AI 處理過程 (這裡先簡單在字串後面加一段字)
            String processedData = content + "\n// 這是經過後端與 AI 處理後加入的新資料！";
            
            // 4. 測試儲存功能
            System.out.println("正在回存檔案...");
            saveFile(processedData, outputFilePath);
        }
    }
}