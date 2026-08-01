package api;

import software.amazon.awssdk.auth.credentials.DefaultCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.bedrockruntime.BedrockRuntimeClient;
import software.amazon.awssdk.services.bedrockruntime.model.InvokeModelRequest;
import software.amazon.awssdk.services.bedrockruntime.model.InvokeModelResponse;
import software.amazon.awssdk.core.SdkBytes;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

public class BedrockAgent {

    private static final BedrockRuntimeClient client = BedrockRuntimeClient.builder()
            .credentialsProvider(DefaultCredentialsProvider.create())
            .region(Region.US_WEST_2)
            .build();

    // 🌟 新增了 role (角色) 參數
    public static String analyzeDebate(String role, String topic, String content) {
        try {
            System.out.println("🤖 正在啟動 [" + role + "] 專屬 AI 模型...");

            // ⚠️ 保護機制：大會規定每秒最多 1 個請求，加入 1.5 秒冷卻時間避免被封鎖
            Thread.sleep(1500);

            // 🌟 核心戰術：AI 投資委員會 (4 位專家 + 1 位總召)
            // 💡 這裡統一先使用 Claude 3 Haiku 型號，確保回應速度最快，避免前端等太久 Timeout。
            // 🌟 核心戰術：AI 投資委員會 (使用最新世代的 Claude 5 Sonnet 模型)
            String modelId = "us.anthropic.claude-haiku-4-5-20251001-v1:0"; 
            String rolePrompt;

            switch (role) {
                case "技術分析":
                    rolePrompt = "你是 AI 投資委員會的「技術分析專家」。請根據 K 線圖、均線、RSI、MACD 等技術指標，分析當前市場趨勢與支撐壓力位，並給出客觀的技術面判斷。";
                    break;
                case "風險控制":
                    rolePrompt = "你是 AI 投資委員會的「風險控制專家」。請根據使用者的歷史最大回撤與波動率，評估當前市場的下行風險，並給出資金控管與停損停利的嚴格建議。";
                    break;
                case "市場情緒":
                    rolePrompt = "你是 AI 投資委員會的「市場情緒專家」。請根據近期的新聞消息、恐慌貪婪指數與社群熱度，判斷目前市場是處於 FOMO 還是恐慌狀態，並抓出潛在的情緒反轉點。";
                    break;
                case "行為分析":
                    rolePrompt = "你是 AI 投資委員會的「行為分析專家」。請根據使用者的歷史交易紀錄與習慣，分析該使用者容易犯的心理偏誤（如追高殺低），並給出專屬的行為矯正建議。";
                    break;
                case "總召集人":
                default:
                    rolePrompt = "你是 AI 投資委員會的「總召集人」。請綜合所有專家的意見與當前市場狀況，給出最終且明確的交易決策建議（必須包含：買進 / 持有 / 賣出）。";
                    break;
            }

            // 組合專屬的 Prompt
            String prompt = String.format("%s\n\n辯論題目：%s\n目前論述內容：%s", rolePrompt, topic, content);

            // 建立 AWS Bedrock 要求的 JSON 格式
            JsonObject message = new JsonObject();
            message.addProperty("role", "user");
            
            JsonObject contentObj = new JsonObject();
            contentObj.addProperty("type", "text");
            contentObj.addProperty("text", prompt);
            
            message.add("content", new com.google.gson.JsonArray());
            message.getAsJsonArray("content").add(contentObj);

            JsonObject payload = new JsonObject();
            payload.addProperty("anthropic_version", "bedrock-2023-05-31");
            payload.addProperty("max_tokens", 1000); // 控制回答長度
            payload.add("messages", new com.google.gson.JsonArray());
            payload.getAsJsonArray("messages").add(message);

            SdkBytes body = SdkBytes.fromUtf8String(payload.toString());

            InvokeModelRequest request = InvokeModelRequest.builder()
                    .modelId(modelId)
                    .body(body)
                    .contentType("application/json")
                    .accept("application/json")
                    .build();

            InvokeModelResponse response = client.invokeModel(request);

            String responseBody = response.body().asUtf8String();
            JsonObject jsonResponse = JsonParser.parseString(responseBody).getAsJsonObject();
            
            return jsonResponse.getAsJsonArray("content").get(0).getAsJsonObject().get("text").getAsString();

        } catch (Exception e) {
            return "❌ AWS Bedrock 分析失敗 (" + role + ")：" + e.getMessage();
        }
    }
}