import boto3
import json
from dotenv import load_dotenv

load_dotenv()
client = boto3.client('bedrock-runtime', region_name='us-west-2')
body = json.dumps({
    "anthropic_version": "bedrock-2023-05-31",
    "max_tokens": 150,
    "temperature": 0.5,
    "messages": [{"role": "user", "content": [{"type": "text", "text": "Hello!"}]}]
})

response = client.invoke_model(
    modelId='us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    body=body
)
print("Raw response body:", response.get('body'))
res_body = response.get('body').read()
print("Read body:", res_body)
parsed = json.loads(res_body)
print("Parsed:", parsed)
print("Text:", parsed.get('content')[0]['text'])
