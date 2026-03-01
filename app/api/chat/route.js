import { generateText } from 'ai';
import { createGroq } from '@ai-sdk/groq';

export const runtime = 'edge';

const CODE_INTENT_REGEX =
  /(code|react|next|tsx|ts|typescript|js|javascript|component|api|endpoint|diff|patch|file)/i;

const DIFF_SYSTEM_PROMPT = `
You are a coding agent. For coding tasks, respond ONLY as a unified diff patch.

Rules:
1) Output only diff content, no prose.
2) Use this patch envelope:
*** Begin Patch
*** Add File: <path>   OR   *** Update File: <path>
...diff lines...
*** End Patch
3) Keep edits focused and runnable.
4) If user asks for multiple files, include all of them in one patch.
`.trim();

function isCodeIntent(messages) {
  const lastUser = [...messages].reverse().find((msg) => msg?.role === 'user');
  return typeof lastUser?.content === 'string' && CODE_INTENT_REGEX.test(lastUser.content);
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .filter((msg) => msg && typeof msg === 'object' && typeof msg.content === 'string')
    .map((msg) => {
      const role = ['system', 'user', 'assistant'].includes(msg.role) ? msg.role : 'user';
      return { role, content: msg.content };
    });
}

export async function POST(request) {
  try {
    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) {
      return Response.json({ error: 'Server is missing GROQ_API_KEY.' }, { status: 500 });
    }

    const payload = await request.json();
    const normalizedMessages = normalizeMessages(payload?.messages);

    if (!normalizedMessages.length) {
      return Response.json({ error: 'Invalid payload: messages must be a non-empty array.' }, { status: 400 });
    }

    const requestMessages = isCodeIntent(normalizedMessages)
      ? [{ role: 'system', content: DIFF_SYSTEM_PROMPT }, ...normalizedMessages]
      : normalizedMessages;

    const groq = createGroq({ apiKey: groqApiKey });
    const { text: content } = await generateText({
      model: groq('moonshotai/kimi-k2-instruct-0905'),
      messages: requestMessages,
      temperature: 0.7
    });

    return Response.json({ content });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : 'Unknown server error.'
      },
      { status: 500 }
    );
  }
}
