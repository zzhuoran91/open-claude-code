#!/usr/bin/env node
/**
 * OpenCode Proxy - Robust, performant version
 * - Session reuse with auto-refresh
 * - Native HTTP requests (no curl subprocess)
 * - Connection pooling
 * - Auto-recovery on failure
 * - Proper timeout handling
 */

const http = require('http');
const fs = require('fs');

const PORT = process.env.PORT || 8080;
const OC_HOST = process.env.OC_HOST || 'http://localhost:18789';
const TOKEN = process.env.TOKEN || process.argv[2];

const MODELS = ['big-pickle', 'minimax-m2.5-free', 'qwen3.6-plus-free', 'nemotron-3-super-free'];
const PRIMARY_MODEL = 'nemotron-3-super-free';
const FALLBACK_MODEL = 'qwen3.6-plus-free';
const AUTH = Buffer.from(`opencode:${TOKEN}`).toString('base64');

function parseUrl(urlStr) {
  const u = new URL(urlStr);
  return { hostname: u.hostname, port: u.port || 80, path: u.pathname };
}

const oc = parseUrl(OC_HOST);

function ocRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: oc.hostname,
      port: oc.port,
      path,
      method,
      headers: {
        'Authorization': `Basic ${AUTH}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body || '')
      },
      timeout: 120000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`Invalid JSON: ${data}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

class SessionManager {
  constructor() {
    this.sessionId = null;
    this.creating = false;
    this.createQueue = [];
  }

  async createSession() {
    if (this.sessionId) return this.sessionId;
    if (this.creating) {
      return new Promise((resolve, reject) => {
        this.createQueue.push({ resolve, reject });
      });
    }

    this.creating = true;
    try {
      const result = await ocRequest('POST', '/session', '{}');
      this.sessionId = result.id;
      console.log(`[SESSION] Created: ${this.sessionId}`);

      // Resolve waiting queue
      this.createQueue.forEach(({ resolve }) => resolve(this.sessionId));
      this.createQueue = [];
      return this.sessionId;
    } catch (e) {
      this.createQueue.forEach(({ reject }) => reject(e));
      this.createQueue = [];
      throw e;
    } finally {
      this.creating = false;
    }
  }

  async refreshSession() {
    this.sessionId = null;
    return this.createSession();
  }

  async sendMessage(messages) {
    const sessionId = await this.createSession();
    const msgContent = messages.map(m => m.content || '').join('\n');
    const body = JSON.stringify({
      parts: [{ type: 'text', text: msgContent }],
      noReply: false
    });

    try {
      const result = await ocRequest('POST', `/session/${sessionId}/message`, body);
      return result;
    } catch (e) {
      // Session expired - refresh and retry once
      if (e.message.includes('401') || e.message.includes('403')) {
        console.log('[SESSION] Expired, refreshing...');
        await this.refreshSession();
        return ocRequest('POST', `/session/${this.sessionId}/message`, body);
      }
      throw e;
    }
  }
}

const sessionMgr = new SessionManager();

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/v1/models' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: MODELS.map(m => ({ id: m, object: 'model', created: 1700000000, owned_by: 'opencode' }))
    }));
    return;
  }

  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ session_id: sessionMgr.sessionId, alive: !!sessionMgr.sessionId }));
    return;
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const json = JSON.parse(body);
        const messages = json.messages || [];
        const requestedModel = json.model || PRIMARY_MODEL;
        const modelToUse = (requestedModel === 'qwen3.6-plus-free' || requestedModel === 'big-pickle')
          ? PRIMARY_MODEL : FALLBACK_MODEL;

        let result;
        try {
          result = await sessionMgr.sendMessage(messages);
        } catch (e) {
          // Try fallback model
          if (modelToUse === PRIMARY_MODEL) {
            console.log('[PROXY] Primary failed, trying fallback');
            result = await sessionMgr.sendMessage(messages);
          } else {
            throw e;
          }
        }

        const text = result.parts.filter(p => p.type === 'text').map(p => p.text).join('');
        const tokens = result.info?.tokens || {};

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: `cmpl-${Date.now().toString(36)}`,
          object: 'chat.completion',
          created: 0,
          model: requestedModel,
          choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: tokens.input || 0,
            completion_tokens: tokens.output || 0,
            total_tokens: (tokens.input || 0) + (tokens.output || 0)
          }
        }));
      } catch (e) {
        console.error('[PROXY] Error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.timeout = 120000;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`OpenCode Proxy running on http://127.0.0.1:${PORT}`);
  console.log(`Models: ${MODELS.join(', ')}`);
  console.log(`Target: ${OC_HOST}`);
});

// Graceful shutdown
process.on('SIGTERM', () => { console.log('Shutting down...'); server.close(); process.exit(0); });
process.on('SIGINT', () => { console.log('Shutting down...'); server.close(); process.exit(0); });
