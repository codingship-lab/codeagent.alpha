import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { createGroq } from '@ai-sdk/groq';
import { AgentRuntime } from './agent-runtime.js';
import { VercelSandboxManager } from './vercel-sandbox-manager.js';

dotenv.config();

const app = express();

const port = Number.parseInt(process.env.PORT || '8788', 10);
const previewPort = Number.parseInt(process.env.PREVIEW_PORT || '3000', 10);
const cwd = process.cwd();
const parentDir = path.resolve(cwd, '..');
const defaultWorkspaceRoot =
  path.basename(cwd) === 'runtime' && fs.existsSync(path.join(parentDir, 'package.json')) ? parentDir : cwd;
const workspaceRoot = process.env.WORKSPACE_ROOT || defaultWorkspaceRoot;
const groqApiKey = process.env.GROQ_API_KEY;
const allowedOrigins = String(process.env.CORS_ORIGIN || '*')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const groq = createGroq({ apiKey: groqApiKey });
const runtime = new AgentRuntime({ groq, workspaceRoot });
const previewManager = new VercelSandboxManager({ port: previewPort });

if (!groqApiKey) {
  console.warn('GROQ_API_KEY is not set. Runtime requests will fail until configured.');
}

app.use((req, res, next) => {
  const requestOrigin = req.headers.origin;
  const hasWildcard = allowedOrigins.includes('*');

  if (hasWildcard) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  next();
});

app.use(express.json({ limit: '4mb' }));

app.post('/api/arena', async (req, res) => {
  try {
    if (!groqApiKey) {
      return res.status(500).json({ error: 'Server is missing GROQ_API_KEY.' });
    }

    const { messages } = req.body;
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid payload: messages must be an array.' });
    }

    const result = await runtime.run(messages);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown server error.' });
  }
});

app.post('/api/arena/stream', async (req, res) => {
  const sendSse = (eventName, payload) => {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (typeof res.flush === 'function') {
      res.flush();
    }
  };

  try {
    if (!groqApiKey) {
      return res.status(500).json({ error: 'Server is missing GROQ_API_KEY.' });
    }

    const { messages } = req.body;
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid payload: messages must be an array.' });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Content-Encoding', 'identity');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');

    if (res.socket) {
      res.socket.setNoDelay(true);
    }

    res.flushHeaders();
    sendSse('heartbeat', { ok: true });

    for await (const event of runtime.runStream(messages)) {
      const eventName = String(event?.type || '').startsWith('run.') ? 'run' : 'step';
      sendSse(eventName, event);
    }

    sendSse('end', { ok: true });
    return res.end();
  } catch (error) {
    sendSse('error', {
      error: error instanceof Error ? error.message : 'Unknown server error.'
    });
    return res.end();
  }
});

app.post('/api/preview/sync', async (req, res) => {
  try {
    const { sessionId, patch } = req.body || {};

    if (typeof patch !== 'string' || !patch.trim()) {
      return res.status(400).json({ error: 'Invalid payload: patch must be a non-empty string.' });
    }

    const state = await previewManager.syncPatch({ sessionId, patch });
    return res.json(state);
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown preview sync error.' });
  }
});

app.get('/api/preview/state', async (req, res) => {
  try {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    if (!sessionId) {
      return res.status(400).json({ error: 'query parameter sessionId is required.' });
    }

    const state = await previewManager.getState(sessionId);
    return res.json(state);
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown preview state error.' });
  }
});

app.listen(port, () => {
  console.log(`CodeAgent runtime is running on http://localhost:${port}`);
});
