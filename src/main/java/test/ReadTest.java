import java.nio.file.Files;
import java.nio.file.Path;

public class ReadTest {
    public static void main(String[] args) {
        try {
            // 指定要讀取的檔案名稱
            String content = Files.readString(Path.of("test.txt"));
            
            // 把讀到的東西印出來
            System.out.println("✅ 成功讀到檔案內容：" + content);
            
        } catch (Exception e) {
            System.out.println("❌ 讀取失敗，可能是檔案找不到");
        }
    }
}