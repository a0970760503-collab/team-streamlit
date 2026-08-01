# AWS 無伺服器部署

此版本以原專案的 `web/` 前端與市場／新聞／AI 分析邏輯為基礎，部署為：

```text
瀏覽器 → CloudFront → 私有 S3 網頁檔案
瀏覽器 → API Gateway HTTP API → Lambda → MAX 公開 API／Cointelegraph／Anthropic
                                      └→ Secrets Manager（Anthropic API key）
```

`/api/trade` 沒有被部署。公開網站的下單畫面只會顯示模擬結果，不會保存 MAX 金鑰、也不會建立真實委託。

## 先決條件

- AWS CLI 已登入 Workshop 提供的帳號；確認區域使用 `us-west-2`。
- AWS SAM CLI 已安裝。
- 此帳號可建立 CloudFormation、Lambda、API Gateway、S3、CloudFront、CloudWatch Logs、X-Ray 與 Secrets Manager 資源。
- 一個 Anthropic API key。它只會放在 AWS Secrets Manager，絕對不要放在 `web/`、`.env` 或 Git。

## 1. 建立 API 金鑰 Secret

在 PowerShell 設定自己的 key 後執行；這會建立一個 JSON Secret，名稱可以自行調整。

```powershell
$anthropicKey = '請貼上你的 Anthropic API key'
aws secretsmanager create-secret --region us-west-2 --name ai-investment-committee/anthropic --secret-string (ConvertTo-Json @{ ANTHROPIC_API_KEY = $anthropicKey } -Compress)
```

從輸出中複製 `ARN`。若 Secret 已存在，請改用 `aws secretsmanager put-secret-value` 更新，不要把 key 寫進程式碼。

## 2. 部署

在專案根目錄執行：

```powershell
.\aws\deploy.ps1 -AnthropicSecretArn '貼上剛才的 Secret ARN' -Region us-west-2
```

部署腳本會建立 Lambda、API Gateway、私有 S3 bucket、CloudFront，接著上傳 `web/`，並自動把 API Gateway URL 寫入 S3 的 `config.js`。CloudFront 第一次建立通常需要幾分鐘；最後輸出的 URL 就是公開網站網址。

## 成本與保護

- Lambda 設定為最多 3 個同時執行，以限制 AI 呼叫成本；這不是使用者驗證或完整防濫用機制。
- 任何公開網站都可能遭到請求濫用。若正式對外開放，建議下一步加上 CloudFront/WAF rate rule、登入機制，並限制誰能使用 AI 分析。
- 移除整個 stack 前，請先確認沒有人仍使用網站；CloudFormation 刪除後 CloudFront、S3 與 API URL 都會失效。
