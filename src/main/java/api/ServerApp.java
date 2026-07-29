package api; // 宣告我住在 api 這個資料夾裡

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@SpringBootApplication // 告訴 Java：這不是普通程式，這是一台 Web 伺服器！
@RestController        // 告訴 Java：我要開始開通網址 (API 接口) 了！
public class ServerApp {

    public static void main(String[] args) {
        // 啟動伺服器！
        SpringApplication.run(ServerApp.class, args);
    }

    // 當前端連線到 http://localhost:8080/test 時，就會觸發這個方法
    @GetMapping("/test")
    public String testConnection() {
        return "✅ 太神啦！你的 Spring Boot API 伺服器已經成功啟動！前端可以準備串接了！";
    }
}