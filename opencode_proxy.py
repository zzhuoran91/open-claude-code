#!/usr/bin/env python3
"""
OpenCode Session Proxy - OpenAI-compatible gateway to OpenCode's free models.
Supports primary (minimax-m2.5-free) and fallback (qwen3.6-plus-free) models.
"""

import argparse
import json
import uuid
from http.server import HTTPServer, BaseHTTPRequestHandler
import urllib.request
import base64

PRIMARY_MODEL = "minimax-m2.5-free"
FALLBACK_MODEL = "qwen3.6-plus-free"
ZEN_MODELS = ["big-pickle", PRIMARY_MODEL, FALLBACK_MODEL, "nemotron-3-super-free"]

class ProxyHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == '/v1/chat/completions':
            self.handle_chat()
        else:
            self.send_error(404)
    
    def do_GET(self):
        if self.path == '/v1/models':
            self.list_models()
        else:
            self.send_error(404)
    
    def list_models(self):
        data = [{"id": m, "object": "model", "created": 1700000000, "owned_by": "opencode"} for m in ZEN_MODELS]
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({"object": "list", "data": data}).encode())
    
    def handle_chat(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
        messages = body.get('messages', [])
        requested_model = body.get('model', PRIMARY_MODEL)
        
        import subprocess
        
        token = self.server.token
        
        # Determine model to use (primary or fallback)
        model_to_use = PRIMARY_MODEL if requested_model in [PRIMARY_MODEL, "big-pickle"] else FALLBACK_MODEL
        
        # Try primary model first
        success, response = self.send_message_to_opencode(token, messages, model_to_use)
        
        if not success and model_to_use == PRIMARY_MODEL:
            # Fallback to qwen3.6-plus-free if primary fails
            print(f"[DEBUG] Primary model failed, trying fallback", flush=True)
            success, response = self.send_message_to_opencode(token, messages, FALLBACK_MODEL)
        
        if not success:
            self.send_error(500, response)
            return
        
        result = response
        text = "".join(p.get('text','') for p in result.get('parts',[]) if p.get('type')=='text')
        tokens = result.get('info',{}).get('tokens',{})
        
        out = {
            "id": f"cmpl-{uuid.uuid4().hex[:8]}",
            "object": "chat.completion",
            "created": 0,
            "model": requested_model,
            "choices": [{"message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            "usage": {
                "prompt_tokens": tokens.get('input', 0),
                "completion_tokens": tokens.get('output', 0),
                "total_tokens": tokens.get('input', 0) + tokens.get('output', 0)
            }
        }
        
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(out).encode())
    
    def send_message_to_opencode(self, token, messages, model):
        """Create session and send message, return (success, response)"""
        import subprocess
        import tempfile
        import os
        
        # Step 1: Create session
        cmd = f'curl -s -X POST "{self.server.oc_host}/session" -u "opencode:{token}" -H "Content-Type: application/json" -d \'{{}}\''
        
        try:
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30)
            if result.returncode != 0:
                return False, f"curl failed: {result.stderr}"
            session_data = json.loads(result.stdout)
            session_id = session_data.get('id')
            if not session_id:
                return False, f"No session id: {result.stdout}"
        except Exception as e:
            return False, f"Failed: {e}"
        
        # Step 2: Send message - write JSON to temp file to avoid shell escaping
        msg_content = " ".join(m.get('content', '') for m in messages)
        
        msg_payload = {
            "parts": [{"type": "text", "text": msg_content}],
            "noReply": False
        }
        
        # Write to temp file to avoid shell escaping issues
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump(msg_payload, f)
            temp_file = f.name
        
        try:
            cmd2 = f'curl -s -X POST "{self.server.oc_host}/session/{session_id}/message" -u "opencode:{token}" -H "Content-Type: application/json" --data-binary @{temp_file}'
            result2 = subprocess.run(cmd2, shell=True, capture_output=True, text=True, timeout=120)
            if result2.returncode != 0:
                return False, f"curl failed: {result2.stderr}"
            result = json.loads(result2.stdout)
            return True, result
        except Exception as e:
            return False, f"Failed: {e}"
        finally:
            os.unlink(temp_file)

class Server(HTTPServer):
    def __init__(self, host, port, oc_host, token, session):
        print(f"[START] Server init: host={host}, port={port}, oc_host={oc_host}, session={session}, token={token}", flush=True)
        with open('/tmp/debug2.txt', 'w') as f:
            f.write(f"INIT: token={token}\n")
        super().__init__((host, port), ProxyHandler)
        self.oc_host, self.token, self.session = oc_host, token, session

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--port', type=int, default=8080)
    p.add_argument('--host', default='127.0.0.1')
    p.add_argument('--opencode-host', default='http://localhost:18789')
    p.add_argument('--token', default='6f6177221784643f6de541785289a781c40417c88023ff8c')
    p.add_argument('--session', default='ses_2a36d8675ffenJPk7wCh6XvXJ2')
    a = p.parse_args()
    
    s = Server(a.host, a.port, a.opencode_host, a.token, a.session)
    print(f"OpenCode Proxy: http://{a.host}:{a.port}")
    print(f"Models: {ZEN_MODELS}")
    print(f"\nTo use with Open Claude Code:")
    print(f"  LLM_PROVIDER=openai_compat")
    print(f"  LLM_BASE_URL=http://localhost:8080/v1")
    print(f"  LLM_API_KEY=any")
    print(f"  LLM_MODEL=big-pickle")
    
    s.serve_forever()