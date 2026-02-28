import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateText } from 'ai';
import { createGroq } from '@ai-sdk/groq';
import { AgentRuntime } from './agent-runtime.js';
import { VercelSandboxManager } from './vercel-sandbox-manager.js';

dotenv.config();

const app = express();
const port = Number.parseInt(process.env.PORT || '3000', 10);
const previewPort = Number.parseInt(process.env.PREVIEW_PORT || '3000', 10);
const groqApiKey = process.env.GROQ_API_KEY;
const groq = createGroq({ apiKey: groqApiKey });
const runtime = new AgentRuntime({ groq, workspaceRoot: process.cwd() });
const previewManager = new VercelSandboxManager({ port: previewPort });

const CODE_INTENT_REGEX =
  /(код|code|react|next|tsx|ts|typescript|js|javascript|component|компонент|api|endpoint|diff|patch|файл|file)/i;

const DIFF_SYSTEM_PROMPT = `
You are a coding agent. For coding tasks, respond ONLY as a unified diff patch.

Rules:
1) Output only diff content, no prose.
2) Use this patch envelope:
*** Begin Patch
*** Add File: <path>   OR   *** Update File: <path>
...diff lines...
*** End Patch
3) If creating files, prefer this minimal baseline app shape:
- src/main.tsx
- src/App.tsx
- src/index.css
- package.json
- tsconfig.json
- vite.config.ts
4) Keep edits focused and runnable.
5) If user asks for multiple files, include all of them in one patch.
`.trim();

function isCodeIntent(messages) {
  const lastUser = [...messages].reverse().find((msg) => msg?.role === 'user');
  return typeof lastUser?.content === 'string' && CODE_INTENT_REGEX.test(lastUser.content);
}

if (!groqApiKey) {
  console.warn('GROQ_API_KEY is not set. Requests to /api/chat will fail until configured.');
}

app.use(express.json({ limit: '4mb' }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve React production build from 'dist'
app.use(express.static(path.join(__dirname, 'dist')));

app.post('/api/chat', async (req, res) => {
  try {
    if (!groqApiKey) {
      return res.status(500).json({ error: 'Server is missing GROQ_API_KEY.' });
    }

    const { messages } = req.body;

    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid payload: messages must be an array.' });
    }

    const normalizedMessages = messages
      .filter((msg) => msg && typeof msg === 'object' && typeof msg.content === 'string')
      .map((msg) => {
        const safeRole = ['system', 'user', 'assistant'].includes(msg.role) ? msg.role : 'user';
        return { role: safeRole, content: msg.content };
      });

    const requestMessages = isCodeIntent(normalizedMessages)
      ? [{ role: 'system', content: DIFF_SYSTEM_PROMPT }, ...normalizedMessages]
      : normalizedMessages;

    const { text: content } = await generateText({
      model: groq('moonshotai/kimi-k2-instruct-0905'),
      messages: requestMessages,
      temperature: 0.7
    });

    return res.json({ content });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown server error.' });
  }
});

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

app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(port, () => {
  console.log(`CodeAgent chat running on http://localhost:${port}`);
});
