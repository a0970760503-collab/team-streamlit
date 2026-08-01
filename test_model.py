import boto3
import json
from dotenv import load_dotenv

load_dotenv()
try:
    client = boto3.client('bedrock-runtime', region_name='us-west-2')
    response = client.invoke_model(
        modelId='us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        body=json.dumps({
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 10,
            "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]
        })
    )
    result = json.loads(response.get('body').read())
    print("SUCCESS:", result.get('content')[0]['text'])
except Exception as e:
    print("ERROR:", e)
