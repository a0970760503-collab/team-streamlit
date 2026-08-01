import urllib.request
import json

url = "http://localhost:8080/api/chat_assistant"
data = json.dumps({"text": "Hello"}).encode('utf-8')
req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})

try:
    with urllib.request.urlopen(req, timeout=10) as response:
        result = response.read().decode('utf-8')
        print("HTTP Response Code:", response.getcode())
        print("Response Body:", result)
except Exception as e:
    print("HTTP Request Failed:", e)
    if hasattr(e, 'read'):
        print(e.read().decode('utf-8'))
