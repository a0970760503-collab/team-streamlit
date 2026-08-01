import boto3
from dotenv import load_dotenv

load_dotenv()
client = boto3.client('bedrock')
try:
    profiles = client.list_inference_profiles()
    for profile in profiles.get('inferenceProfileSummaries', []):
        name = profile['inferenceProfileId']
        if 'sonnet-4-6' in name.lower() or 'claude-sonnet' in name.lower() or 'claude-4' in name.lower():
            print("Found inference profile:", name)
            
    models = client.list_foundation_models()
    for model in models.get('modelSummaries', []):
        name = model['modelId']
        if 'sonnet-4-6' in name.lower() or 'claude' in name.lower():
            print("Found base model:", name)
except Exception as e:
    print(e)
