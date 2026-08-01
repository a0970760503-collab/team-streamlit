import boto3
import json
from dotenv import load_dotenv

load_dotenv()
client = boto3.client('bedrock', region_name='us-west-2')
response = client.list_foundation_models()
models = response.get('modelSummaries', [])
anthropic_models = [m['modelId'] for m in models if 'anthropic' in m['modelId'].lower()]
for m in anthropic_models:
    print(m)
