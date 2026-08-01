import boto3
from dotenv import load_dotenv

load_dotenv()
try:
    client = boto3.client('bedrock', region_name='us-west-2')
    response = client.list_inference_profiles()
    for profile in response.get('inferenceProfileSummaries', []):
        if 'anthropic' in profile['inferenceProfileId']:
            print(profile['inferenceProfileId'])
except Exception as e:
    print("ERROR:", e)
