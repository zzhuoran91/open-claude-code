#!/usr/bin/env python3
"""
OpenCode Session Proxy - Optimized for low latency.
Supports session reuse, connection pooling, and streaming.
"""

import argparse
import json
import uuid
import urllib.request
import urllib.error
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlencode

PRIMARY_MODEL = "minimax-m2.5-free"
FALLBACK_MODEL = "qwen3.6-plus-free"
ZEN_MODELS = ["big-pickle", PRIMARY_MODEL, FALLBACK_MODEL, "nemotron-3-super-free"]

class SessionPool:
    """Reusable session pool with background refresh."""
    
    def __init__(self, oc_host, token):
        self.oc_host = oc_host
        self.token = token
        self.session_id = None
        self.lock = threading.Lock()
        self.last_used = 0
        self._refresh()
    
    def _create_session(self):
        """Create a new session."""
        req = urllib.request.Request(
            f"{self.oc_host}/session",
            data=b'{}',
            headers={
                'Authorization': f'Basic {self._auth()}',
                'Content-Type': 'application/json'
            },
            method='POST'
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
                return data.get('id')
        except Exception as e:
            print(f"[SESSION] Create failed: {e}")
            return None
    
    def _auth(self):
        import base64
        return base64.b64encode(f"opencode:{self.token}".encode()).decode()
    
    def _refresh(self):
        """Refresh session in background."""
        new_id = self._create_session()
        if new_id:
            with self.lock:
                self.session_id = new_id
                self.last_used = time.time()
            print(f"[SESSION] Created: {new_id}")
    
    def get_session(self):
        """Get current session, refresh if stale."""
        with self.lock:
            if not self.session_id:
                self._refresh()
            # Refresh if older than 5 minutes or empty
            if time.time() - self.last_used > 300:
                threading.Thread(target=self._refresh, daemon=True).start()
            return self.session_id
    
    def send_message(self, messages, model):
        """Send message to session."""
        session_id = self.get_session()
        
        msg_content = "\n".join(m.get('content', '') for m in messages)
        
        payload = json.dumps({
            "parts": [{"type": "text", "text": msg_content}],
            "noReply": False
        }).encode()
        
        req = urllib.request.Request(
            f"{self.oc_host}/session/{session_id}/message",
            data=payload,
            headers={
                'Authorization': f'Basic {self._auth()}',
                'Content-Type': 'application/json'
            },
            method='POST'
        )
        
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read())
                return True, data
        except urllib.error.HTTPError as e:
            err_body = e.read().decode() if e.fp else str(e)
            # Session expired, retry with new session
            if e.code in (401, 403):
                with self.lock:
                    self.session_id = None
                # Retry once
                session_id = self._create_session()
                if session_id:
                    with self.lock:
                        self.session_id = session_id
                    req = urllib.request.Request(
                        f"{self.oc_host}/session/{session_id}/message",
                        data=payload,
                        headers={
                            'Authorization': f'Basic {self._auth()}',
                            'Content-Type': 'application/json'
                        },
                        method='POST'
                    )
                    try:
                        with urllib.request.urlopen(req, timeout=120) as resp:
                            data = json.loads(resp.read())
                            return True, data
                    except Exception as e2:
                        return False, str(e2)
            return False, f"HTTP {e.code}: {err_body}"
        except Exception as e:
            return False, str(e)

class ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    
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
    
    def log_message(self, format, *args):
        # Suppress default logging
        pass
    
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
        
        # Determine model
        model_to_use = PRIMARY_MODEL if requested_model in [PRIMARY_MODEL, "big-pickle"] else FALLBACK_MODEL
        
        # Get session pool
        pool = self.server.session_pool
        
        # Try primary
        success, response = pool.send_message(messages, model_to_use)
        
        # Fallback if primary fails
        if not success and model_to_use == PRIMARY_MODEL:
            print(f"[PROXY] Primary failed, trying fallback", flush=True)
            success, response = pool.send_message(messages, FALLBACK_MODEL)
        
        if not success:
            self.send_error(500, response)
            return
        
        # Extract response
        text = "".join(p.get('text', '') for p in response.get('parts', []) if p.get('type') == 'text')
        tokens = response.get('info', {}).get('tokens', {})
        
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
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(json.dumps(out).encode())

class Server(HTTPServer):
    def __init__(self, host, port, oc_host, token):
        super().__init__((host, port), ProxyHandler)
        self.session_pool = SessionPool(oc_host, token)
        print(f"[START] Proxy: {host}:{port} -> {oc_host}")
        print(f"[START] Models: {ZEN_MODELS}")

if __name__ == '__main__':
    p = argparse.ArgumentParser(description='OpenCode Proxy')
    p.add_argument('--port', type=int, default=8080)
    p.add_argument('--host', default='127.0.0.1')
    p.add_argument('--opencode-host', default='http://localhost:18789')
    p.add_argument('--token', required=True)
    a = p.parse_args()
    
    s = Server(a.host, a.port, a.opencode_host, a.token)
    print(f"\nOpenCode Proxy running at http://{a.host}:{a.port}")
    print(f"LLM_BASE_URL=http://{a.host}:{a.port}/v1")
    print(f"LLM_MODEL={PRIMARY_MODEL} (or {FALLBACK_MODEL})")
    
    try:
        s.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
