import fs from 'fs/promises';
import path from 'path';
import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { generateText } from 'ai';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { RUN_EVENT, STEP_EVENT, createRunEvent, createStepEvent } from './event-protocol.js';

const exec = promisify(execCallback);

const DEFAULT_MODEL_ID = 'moonshotai/kimi-k2-instruct-0905';
const MAX_LLM_ITERATIONS = 14;
const MAX_READ_CHARS = 12000;
const MIN_STEP_DURATION_MS = Math.max(0, Number.parseInt(process.env.MIN_STEP_DURATION_MS || '250', 10) || 250);
const BUILD_TIMEOUT_MS = Math.max(15_000, Number.parseInt(process.env.BUILD_TIMEOUT_MS || '90000', 10) || 90_000);
const VALID_PHASES = new Set(['design', 'plan', 'scan_project', 'implement', 'validate', 'deliver']);
const PHASE_GROUP_TITLES = Object.freeze({
  design: 'Design',
  plan: 'Plan',
  scan_project: 'Explore',
  implement: 'Implement',
  validate: 'Validate',
  deliver: 'Deliver'
});
const PATCH_REQUIRED_INTENT_REGEX =
  /(код|code|script|скрипт|react|next|js|javascript|ts|typescript|html|css|api|function|функц|лендинг|landing|сайт|website|component|компонент|ui|верстк|дизайн|patch|файл|создай|создать|добав|измени|исправ)/i;
const READ_FILE_FALLBACK_PATHS = Object.freeze([
  'package.json',
  'app/page.jsx',
  'app/layout.jsx',
  'app/globals.css',
  'components/pages/chat-page.jsx',
  'runtime/server.js',
  'README.md',
  '.'
]);

const RUNTIME_STATE = Annotation.Root({
  runId: Annotation({
    reducer: (_, next) => next,
    default: () => ''
  }),
  stepCount: Annotation({
    reducer: (_, next) => next,
    default: () => 0
  }),
  llmIterations: Annotation({
    reducer: (_, next) => next,
    default: () => 0
  }),
  messages: Annotation({
    reducer: (_, next) => next,
    default: () => []
  }),
  pendingTool: Annotation({
    reducer: (_, next) => next,
    default: () => null
  }),
  pendingPhase: Annotation({
    reducer: (_, next) => next,
    default: () => ''
  }),
  pendingShortStatus: Annotation({
    reducer: (_, next) => next,
    default: () => ''
  }),
  finalMessage: Annotation({
    reducer: (_, next) => next,
    default: () => ''
  }),
  patchText: Annotation({
    reducer: (_, next) => next,
    default: () => ''
  }),
  patchFiles: Annotation({
    reducer: (_, next) => next,
    default: () => []
  }),
  noPatchRetries: Annotation({
    reducer: (_, next) => next,
    default: () => 0
  }),
  shouldStop: Annotation({
    reducer: (_, next) => next,
    default: () => false
  }),
  requiresPatch: Annotation({
    reducer: (_, next) => next,
    default: () => false
  })
});

class AsyncEventQueue {
  constructor() {
    this.queue = [];
    this.waiters = [];
    this.closed = false;
  }

  push(event) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(event);
      return;
    }
    this.queue.push(event);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) {
      const waiter = this.waiters.shift();
      waiter(null);
    }
  }

  async *stream() {
    while (true) {
      if (this.queue.length) {
        yield this.queue.shift();
        continue;
      }

      if (this.closed) {
        return;
      }

      const next = await new Promise((resolve) => this.waiters.push(resolve));
      if (next == null) {
        return;
      }
      yield next;
    }
  }
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((msg) => msg && typeof msg === 'object' && typeof msg.content === 'string')
    .map((msg) => {
      const role = ['system', 'user', 'assistant'].includes(msg.role) ? msg.role : 'user';
      return { role, content: msg.content };
    });
}

function requiresPatchForMessages(messages) {
  const normalized = Array.isArray(messages) ? messages : [];
  const text = normalized
    .filter((item) => item && typeof item === 'object' && item.role === 'user' && typeof item.content === 'string')
    .map((item) => item.content)
    .join('\n');

  return PATCH_REQUIRED_INTENT_REGEX.test(text);
}

function decodeEscapedMultiline(text) {
  let nextText = String(text || '');

  for (let i = 0; i < 8; i += 1) {
    const decoded = nextText
      .replace(/\\\\r\\\\n/g, '\n')
      .replace(/\\r\\n/g, '\n')
      .replace(/\\\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\\\/g, '\\');

    if (decoded === nextText) break;
    nextText = decoded;
  }

  return nextText;
}

function normalizeLF(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function stripContinuationArtifacts(text) {
  const lines = String(text || '').split('\n');
  if (!lines.length) return String(text || '');

  const withTrailingSlash = lines.filter((line) => /\\\s*$/.test(line)).length;
  const ratio = withTrailingSlash / lines.length;

  if (ratio < 0.25) return String(text || '');

  return lines.map((line) => line.replace(/\\\s*$/, '')).join('\n');
}

function findJsonObject(text) {
  const raw = (text || '').trim();
  if (!raw) return null;

  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fenced) {
    return findJsonObject(fenced[1]);
  }

  try {
    return JSON.parse(raw);
  } catch {
    // continue with best effort scan
  }

  let start = -1;
  let depth = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = raw.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          start = -1;
          depth = 0;
        }
      }
    }
  }

  return null;
}

function normalizePatchText(raw) {
  let text = (raw || '').trim();
  if (!text) return '';

  text = decodeEscapedMultiline(text);
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = stripContinuationArtifacts(text);

  const fenced = text.match(/^```(?:diff|patch)?\s*([\s\S]*?)```$/i);
  if (fenced) {
    const inner = decodeEscapedMultiline(fenced[1].trim());
    return stripContinuationArtifacts(inner).trim();
  }
  return text;
}

function parsePatchFiles(patchText) {
  const normalizedPatch = normalizePatchText(patchText).replace(/\r\n/g, '\n');
  const files = [];
  const fileRegex =
    /(?:^|\n)\*\*\* (Add|Update|Create) File: ([^\n]+)\n([\s\S]*?)(?=(?:\n\*\*\* (?:Add|Update|Create) File: )|\n\*\*\* End Patch|$)/g;

  let match;
  while ((match = fileRegex.exec(normalizedPatch)) !== null) {
    const action = match[1] === 'Update' ? 'edited' : 'added';
    const filePath = sanitizePatchPath(match[2]);
    const body = match[3] || '';
    if (!filePath) continue;

    let added = 0;
    let removed = 0;

    for (const line of body.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
      if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
    }

    if (added === 0 && removed === 0) {
      added = body
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean).length;
    }

    files.push({
      path: filePath,
      action,
      added,
      removed
    });
  }

  return files;
}

function sectionBodyToFileContent(body) {
  const normalizedBody = normalizeLF(String(body || ''));
  const lines = normalizedBody.split('\n');
  const hasHunkMarkers = lines.some((line) => line.startsWith('@@'));
  const diffPrefixedLines = lines.filter((line) => /^[ +\-]/.test(line)).length;
  const diffLike = hasHunkMarkers || diffPrefixedLines / Math.max(lines.length, 1) >= 0.7;

  if (!diffLike) {
    return normalizedBody
      .split('\n')
      .filter((line) => !/^\s*\*\*\*\s+(?:Begin Patch|End Patch|Add File:|Update File:|Create File:)\b/.test(line))
      .join('\n')
      .trimEnd();
  }

  const output = [];
  for (const line of lines) {
    if (!line) {
      output.push('');
      continue;
    }
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('\\ No newline at end of file')) continue;
    if (line.startsWith('+')) {
      output.push(line.slice(1));
      continue;
    }
    if (line.startsWith(' ')) {
      output.push(line.slice(1));
      continue;
    }
    if (line.startsWith('-')) {
      continue;
    }
    output.push(line);
  }

  return output.join('\n').trimEnd();
}

function parsePatchHunks(body) {
  const lines = normalizeLF(String(body || '')).split('\n');
  const hunks = [];
  let current = null;

  for (const line of lines) {
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (header) {
      if (current) hunks.push(current);
      current = {
        oldStart: Number.parseInt(header[1], 10) || 1,
        lines: []
      };
      continue;
    }

    if (!current) continue;
    if (line.startsWith('\\ No newline at end of file')) continue;

    const op = line[0];
    if (op === ' ' || op === '+' || op === '-') {
      current.lines.push({ op, text: line.slice(1) });
    } else {
      current.lines.push({ op: ' ', text: line });
    }
  }

  if (current) hunks.push(current);
  return hunks;
}

function applyPatchHunks(baseContent, hunks) {
  const sourceText = normalizeLF(String(baseContent || ''));
  const source = sourceText === '' ? [] : sourceText.split('\n');
  const output = [];
  let cursor = 0;

  for (const hunk of Array.isArray(hunks) ? hunks : []) {
    let oldIndex = Math.max(0, Number.parseInt(String(hunk?.oldStart || '1'), 10) - 1);
    if (!Number.isFinite(oldIndex)) oldIndex = cursor;
    oldIndex = Math.max(cursor, Math.min(oldIndex, source.length));

    while (cursor < oldIndex) {
      output.push(source[cursor]);
      cursor += 1;
    }

    for (const line of Array.isArray(hunk?.lines) ? hunk.lines : []) {
      if (line.op === ' ') {
        if (cursor < source.length) {
          output.push(source[cursor]);
          cursor += 1;
        } else {
          output.push(line.text);
        }
        continue;
      }
      if (line.op === '-') {
        if (cursor < source.length) cursor += 1;
        continue;
      }
      if (line.op === '+') {
        output.push(line.text);
      }
    }
  }

  while (cursor < source.length) {
    output.push(source[cursor]);
    cursor += 1;
  }

  return output.join('\n');
}

function isReadOnlyFsError(error) {
  if (!error || typeof error !== 'object') return false;
  const code = typeof error.code === 'string' ? error.code : '';
  if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') {
    return true;
  }
  const message = String(error.message || '').toLowerCase();
  return message.includes('read-only file system');
}

function parsePatchWriteSections(patchText) {
  const normalizedPatch = normalizePatchText(patchText).replace(/\r\n/g, '\n');
  const sections = [];
  const fileRegex =
    /(?:^|\n)\*\*\* (Add|Update|Create) File: ([^\n]+)\n([\s\S]*?)(?=(?:\n\*\*\* (?:Add|Update|Create) File: )|\n\*\*\* End Patch|$)/g;

  let match;
  while ((match = fileRegex.exec(normalizedPatch)) !== null) {
    const actionRaw = match[1];
    const filePath = sanitizePatchPath(match[2]);
    const body = normalizeLF(match[3] || '');
    if (!filePath) continue;

    const hunks = actionRaw === 'Update' ? parsePatchHunks(body) : [];
    sections.push({
      action: actionRaw === 'Update' ? 'updated' : 'added',
      path: filePath,
      content: sectionBodyToFileContent(body),
      diffLike: hunks.length > 0,
      hunks
    });
  }

  return sections;
}

function sanitizePatchPath(rawPath) {
  let filePath = String(rawPath || '').trim();
  if (!filePath) return '';

  filePath = filePath.replace(/^['"`]+|['"`]+$/g, '');
  filePath = filePath.replace(/\\/g, '/');
  filePath = filePath.replace(/\/+/g, '/');
  filePath = filePath.replace(/^\/+/, '');
  filePath = filePath.replace(/\/+$/, '');
  filePath = filePath.replace(/^[.]\//, '');

  return filePath.trim();
}

function hasEditablePatchSections(patchText) {
  return parsePatchFiles(patchText).length > 0;
}

function mergePatchFiles(prevFiles, nextFiles) {
  const acc = Array.isArray(prevFiles) ? [...prevFiles] : [];
  const incoming = Array.isArray(nextFiles) ? nextFiles : [];

  for (const file of incoming) {
    if (!file || typeof file !== 'object') continue;
    const pathKey = typeof file.path === 'string' ? file.path : '';
    if (!pathKey) continue;

    const existing = acc.find((item) => item.path === pathKey);
    if (!existing) {
      acc.push({
        path: pathKey,
        action: file.action === 'edited' ? 'edited' : 'added',
        added: Number.isFinite(file.added) ? file.added : 0,
        removed: Number.isFinite(file.removed) ? file.removed : 0
      });
      continue;
    }

    existing.action = file.action === 'edited' ? 'edited' : existing.action;
    existing.added = (Number.isFinite(existing.added) ? existing.added : 0) + (Number.isFinite(file.added) ? file.added : 0);
    existing.removed =
      (Number.isFinite(existing.removed) ? existing.removed : 0) + (Number.isFinite(file.removed) ? file.removed : 0);
  }

  return acc;
}

function mergePatchText(prevPatch, nextPatch) {
  const left = normalizePatchText(prevPatch || '');
  const right = normalizePatchText(nextPatch || '');

  if (!left) return right;
  if (!right) return left;

  return `${left}\n\n${right}`;
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function ensureMinStepDuration(stepStartedAt) {
  const elapsed = Date.now() - stepStartedAt;
  if (elapsed < MIN_STEP_DURATION_MS) {
    await sleep(MIN_STEP_DURATION_MS - elapsed);
  }
}

function safeTail(text, max = 1000) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return text.slice(-max);
}

function normalizeBuildCommand(rawCommand) {
  const fallback = 'npm run build';
  const source = typeof rawCommand === 'string' && rawCommand.trim() ? rawCommand.trim() : fallback;
  const compact = source.replace(/\s+/g, ' ').trim().toLowerCase();

  const explicitlyLongRunning =
    /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:dev|start|serve|watch)\b/.test(compact) ||
    /\b(?:vite|next)\s+dev\b/.test(compact);
  const looksLikeBuild = /\bbuild\b/.test(compact);

  if (explicitlyLongRunning || !looksLikeBuild) {
    return {
      command: fallback,
      normalized: true,
      reason: explicitlyLongRunning ? 'blocked_long_running_command' : 'non_build_command'
    };
  }

  return {
    command: source,
    normalized: false,
    reason: ''
  };
}

function resolveWorkspacePath(workspaceRoot, targetPath) {
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    throw new Error('Tool argument "path" must be a non-empty string.');
  }

  const absolute = path.resolve(workspaceRoot, targetPath.trim());
  const normalizedRoot = `${workspaceRoot}${path.sep}`;

  if (absolute !== workspaceRoot && !absolute.startsWith(normalizedRoot)) {
    throw new Error('Path escapes workspace root.');
  }

  return absolute;
}

function normalizeReadRequestPath(targetPath) {
  let value = typeof targetPath === 'string' ? targetPath.trim() : '';
  if (!value) return 'package.json';

  value = value.replace(/^['"`]+|['"`]+$/g, '');
  value = value.replace(/\\/g, '/');
  value = value.replace(/^file:\/+/, '');
  value = value.replace(/^\/var\/task\//, '');
  value = value.replace(/^\/vercel\/sandbox\//, '');
  value = value.replace(/^\/+/, '');
  value = value.replace(/^\.\/+/, '');
  value = value.replace(/\/+$/, '');

  return value || 'package.json';
}

function extractObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function normalizeToolName(name) {
  const normalized = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if (!normalized) return '';

  if (normalized === 'readfile' || normalized === 'file_read' || normalized === 'read') {
    return 'read_file';
  }

  if (normalized === 'applypatch' || normalized === 'patch_apply' || normalized === 'patch') {
    return 'apply_patch';
  }

  if (
    normalized === 'build_project' ||
    normalized === 'run_build' ||
    normalized === 'compile' ||
    normalized === 'npm_build'
  ) {
    return 'build';
  }

  return normalized;
}

function extractFinalMessage(value) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  const obj = extractObject(value);
  if (!obj) return '';

  const candidates = [obj.message, obj.content, obj.text, obj.final, obj.answer];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return '';
}

function asToolCall(name, args) {
  const normalizedName = normalizeToolName(name);
  return {
    kind: 'tool_call',
    tool: {
      name: normalizedName,
      args: extractObject(args) || {}
    }
  };
}

function isFinalType(value) {
  return ['final', 'finish', 'done', 'answer', 'complete'].includes(String(value || '').toLowerCase());
}

function isToolType(value) {
  return ['tool_call', 'tool', 'call_tool', 'action'].includes(String(value || '').toLowerCase());
}

function toSafeFinalFallback(rawText) {
  const raw = String(rawText || '').trim();
  if (!raw) return 'Не удалось получить валидное действие модели. Завершено безопасно.';
  return 'Не удалось распарсить действие модели. Завершено безопасно.';
}

function isRateLimitErrorMessage(text) {
  const raw = String(text || '').toLowerCase();
  return /rate limit|too many requests|quota|tokens per day|resource exhausted|429/.test(raw);
}

function toRateLimitFinalMessage(rawText) {
  const raw = String(rawText || '');
  const retryMatch = raw.match(/try again in\s+([^.]+)\.?/i);
  if (retryMatch && retryMatch[1]) {
    return `Лимит модели достигнут. Повторите запрос через ${retryMatch[1].trim()}.`;
  }
  return 'Лимит модели достигнут. Повторите запрос через пару минут.';
}

function extractPatchEnvelope(text) {
  const raw = String(text || '');
  const match = raw.match(/\*\*\* Begin Patch[\s\S]*?(?:\*\*\* End Patch|$)/);
  return match ? match[0].trim() : '';
}

function parseDecision(rawText) {
  const directPatch = extractPatchEnvelope(rawText);
  if (directPatch) {
    return asToolCall('apply_patch', { patch: directPatch });
  }

  const parsed = findJsonObject(rawText);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Model response is not valid JSON action.');
  }

  if (isFinalType(parsed.type)) {
    return {
      kind: 'final',
      message: extractFinalMessage(parsed) || 'Готово.'
    };
  }

  if (isToolType(parsed.type) && parsed.tool && typeof parsed.tool === 'object') {
    return asToolCall(parsed.tool.name || parsed.tool.toolName || parsed.tool.tool, parsed.tool.args);
  }

  if (isToolType(parsed.type) && (parsed.name || parsed.toolName || parsed.tool)) {
    return asToolCall(parsed.name || parsed.toolName || parsed.tool, parsed.args || parsed.arguments || {});
  }

  if (parsed.type === 'tool_call' && parsed.tool && typeof parsed.tool === 'object') {
    return asToolCall(parsed.tool.name || parsed.tool.toolName || parsed.tool.tool, parsed.tool.args);
  }

  if (parsed.type === 'tool_call' && typeof parsed.tool === 'string') {
    return asToolCall(parsed.tool, parsed.args || parsed.arguments || {});
  }

  if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length) {
    const first = extractObject(parsed.tool_calls[0]) || {};
    const response = asToolCall(first.name || first.tool || first.toolName, first.args || first.arguments || {});
    return {
      ...response,
      trimmed: parsed.tool_calls.length > 1
    };
  }

  if (Array.isArray(parsed.tools) && parsed.tools.length) {
    const first = extractObject(parsed.tools[0]) || {};
    const response = asToolCall(first.name || first.tool || first.toolName, first.args || first.arguments || {});
    return {
      ...response,
      trimmed: parsed.tools.length > 1
    };
  }

  if (String(parsed.decision || '').toLowerCase() === 'tool_call') {
    return asToolCall(parsed.toolName || parsed.name || parsed.tool, parsed.args || parsed.arguments || {});
  }

  if (String(parsed.decision || '').toLowerCase() === 'final') {
    return {
      kind: 'final',
      message: extractFinalMessage(parsed) || 'Готово.'
    };
  }

  if (parsed.final && typeof parsed.final === 'object') {
    const message = extractFinalMessage(parsed.final);
    if (message) {
      return {
        kind: 'final',
        message
      };
    }
  }

  const directToolName = parsed.toolName || parsed.name;
  if (directToolName) {
    return asToolCall(directToolName, parsed.args || parsed.arguments || {});
  }

  if (typeof parsed.tool === 'string' && parsed.tool.trim()) {
    return asToolCall(parsed.tool, parsed.args || parsed.arguments || {});
  }

  const message = extractFinalMessage(parsed);
  if (message) {
    return {
      kind: 'final',
      message
    };
  }

  throw new Error('Model response does not match action schema.');
}

function normalizePhase(value, fallback = '') {
  const phase = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if (VALID_PHASES.has(phase)) {
    return phase;
  }

  return fallback || '';
}

function parseControllerResponse(rawText) {
  const directPatch = extractPatchEnvelope(rawText);
  if (directPatch) {
    return {
      phase: 'implement',
      shortStatus: 'Implementation started',
      action: asToolCall('apply_patch', { patch: directPatch }),
      trimmed: false
    };
  }

  const parsed = findJsonObject(rawText);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Model response is not valid JSON action.');
  }

  const phase = normalizePhase(parsed.phase);
  const shortStatus = typeof parsed.shortStatus === 'string' ? parsed.shortStatus.trim() : '';

  if (parsed.nextAction && typeof parsed.nextAction === 'object') {
    const nextAction = parsed.nextAction;
    const nextType = String(nextAction.type || nextAction.decision || '').trim().toLowerCase();

    if (isFinalType(nextType) || nextAction.final === true) {
      return {
        phase: phase || 'deliver',
        shortStatus,
        action: {
          kind: 'final',
          message: extractFinalMessage(nextAction) || extractFinalMessage(parsed) || 'Готово.'
        },
        trimmed: false
      };
    }

    if (isToolType(nextType) || nextAction.tool || nextAction.toolName || nextAction.name) {
      const nestedTool = nextAction.tool && typeof nextAction.tool === 'object' ? nextAction.tool : null;
      return {
        phase,
        shortStatus,
        action: asToolCall(
          nestedTool?.name || nestedTool?.toolName || nestedTool?.tool || nextAction.toolName || nextAction.name || nextAction.tool,
          nestedTool?.args || nextAction.args || nextAction.arguments || {}
        ),
        trimmed: Array.isArray(nextAction.tool_calls) && nextAction.tool_calls.length > 1
      };
    }
  }

  const legacyDecision = parseDecision(rawText);
  return {
    phase,
    shortStatus,
    action: {
      kind: legacyDecision.kind,
      ...(legacyDecision.kind === 'tool_call'
        ? {
            tool: legacyDecision.tool
          }
        : {
            message: legacyDecision.message
          })
    },
    trimmed: legacyDecision.trimmed === true
  };
}

function mapStepTypeForTool(toolName) {
  if (toolName === 'read_file') return 'read_file';
  if (toolName === 'apply_patch') return 'apply_patch';
  if (toolName === 'build') return 'build';
  return 'tool';
}

function phaseForTool(toolName) {
  if (toolName === 'read_file') return 'scan_project';
  if (toolName === 'build') return 'validate';
  return 'implement';
}

function shortStatusForTool(toolName) {
  if (toolName === 'read_file') return 'Project structure scanned';
  if (toolName === 'apply_patch') return 'Implementation started';
  if (toolName === 'build') return 'Build project';
  return 'Working';
}

function kindForStepType(stepType) {
  if (stepType === 'llm') return 'thought';
  if (stepType === 'read_file') return 'read';
  if (stepType === 'apply_patch') return 'edit';
  if (stepType === 'build') return 'build';
  if (stepType === 'finish') return 'deliver';
  if (stepType === 'runtime') return 'error';
  return 'action';
}

function subtitleForState(state) {
  if (state === 'running') return 'in progress';
  if (state === 'completed') return 'done';
  if (state === 'error') return 'failed';
  return '';
}

function toDisplayPayload({
  stepId = '',
  stepType = '',
  phase = '',
  shortStatus = '',
  state = 'running',
  details = ''
} = {}) {
  const normalizedPhase = normalizePhase(phase);
  const title = String(shortStatus || '').trim() || shortStatusForTool(stepType);

  return {
    kind: kindForStepType(stepType),
    title,
    subtitle: subtitleForState(state),
    groupId: normalizedPhase ? `phase:${normalizedPhase}` : '',
    groupTitle: PHASE_GROUP_TITLES[normalizedPhase] || '',
    details: String(details || '').trim(),
    stepRef: String(stepId || '').trim()
  };
}

function enforceNarrationContract(controller) {
  const response = controller && typeof controller === 'object' ? controller : null;
  if (!response || !response.action || typeof response.action !== 'object') {
    throw new Error('Model response is missing nextAction.');
  }

  if (response.action.kind === 'tool_call') {
    const toolName = String(response.action?.tool?.name || '').trim();
    if (!toolName) {
      throw new Error('Tool name is required for tool_call.');
    }

    const shortStatus = typeof response.shortStatus === 'string' ? response.shortStatus.trim() : '';
    if (!shortStatus) {
      throw new Error('Provide shortStatus before executing tool.');
    }

    return {
      ...response,
      phase: normalizePhase(response.phase, phaseForTool(toolName)),
      shortStatus
    };
  }

  const finalMessage =
    typeof response.action.message === 'string' && response.action.message.trim() ? response.action.message.trim() : 'Готово.';

  return {
    ...response,
    phase: normalizePhase(response.phase, 'deliver'),
    shortStatus: typeof response.shortStatus === 'string' && response.shortStatus.trim() ? response.shortStatus.trim() : 'Delivering result',
    action: {
      kind: 'final',
      message: finalMessage
    }
  };
}

function createFallbackReadFileAction({
  phase = 'scan_project',
  shortStatus = 'Project structure scanned',
  path = 'package.json',
  startLine = 1,
  endLine = 260
} = {}) {
  return {
    phase,
    shortStatus,
    action: {
      kind: 'tool_call',
      tool: {
        name: 'read_file',
        args: {
          path,
          startLine,
          endLine
        }
      }
    },
    trimmed: false
  };
}

function latestUserMessage(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const msg = list[i];
    if (msg && msg.role === 'user' && typeof msg.content === 'string' && msg.content.trim()) {
      return msg.content.trim();
    }
  }
  return '';
}

function inferLandingBrand(userText) {
  const text = String(userText || '').trim();
  if (!text) return 'Fresh Market';

  const quoted =
    text.match(/["'“”«»]([^"'“”«»]{2,60})["'“”«»]/)?.[1] ||
    text.match(/\b([A-Z][A-Za-z0-9&-]{2,})\b/)?.[1] ||
    text.match(/\b([А-ЯЁ][а-яё0-9&-]{2,})\b/u)?.[1];
  if (quoted) return quoted.trim();

  if (/пицц/i.test(text) || /pizza/i.test(text)) return 'Pizza House';
  if (/рыб/i.test(text) || /fish/i.test(text)) return 'NorwayFish';
  if (/клининг|clean/i.test(text)) return 'HouseClean';
  if (/недвиж|real estate|property/i.test(text)) return 'HouseM';

  return 'Fresh Market';
}

function escapeJsString(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

function createAutoLandingPatch(messages) {
  const userText = latestUserMessage(messages);
  const brand = inferLandingBrand(userText);
  const heroTitle =
    /пицц|pizza/i.test(userText)
      ? 'Hot pizza in 30 minutes'
      : /рыб|fish/i.test(userText)
        ? 'Fresh fish delivered daily'
        : 'Modern product landing page';
  const heroSubtitle = `Project: ${userText || 'Landing page'}`;

  const safeBrand = escapeJsString(brand);
  const safeHeroTitle = escapeJsString(heroTitle);
  const safeHeroSubtitle = escapeJsString(heroSubtitle);

  return [
    '*** Begin Patch',
    '*** Update File: package.json',
    '{',
    '  "name": "codeagent-web",',
    '  "private": true,',
    '  "version": "1.0.0",',
    '  "type": "module",',
    '  "scripts": {',
    '    "dev": "next dev",',
    '    "build": "next build",',
    '    "start": "next start"',
    '  },',
    '  "dependencies": {',
    '    "next": "^16.0.0",',
    '    "react": "^19.2.4",',
    '    "react-dom": "^19.2.4"',
    '  },',
    '  "devDependencies": {}',
    '}',
    '*** Add File: app/layout.jsx',
    "import './globals.css';",
    '',
    `export const metadata = { title: '${safeBrand}' };`,
    '',
    'export default function RootLayout({ children }) {',
    '  return (',
    '    <html lang="en">',
    '      <body>{children}</body>',
    '    </html>',
    '  );',
    '}',
    '*** Add File: app/page.jsx',
    'const cards = [',
    "  { title: 'Fast delivery', text: 'Delivered in 30-45 minutes in your area.' },",
    "  { title: 'Fresh ingredients', text: 'Prepared daily with quality ingredients.' },",
    "  { title: 'Online ordering', text: 'Place an order from any device in one minute.' }",
    '];',
    '',
    'export default function Page() {',
    '  return (',
    '    <div className="page">',
    '      <header className="hero">',
    '        <div className="hero__inner">',
    `          <p className="hero__brand">${safeBrand}</p>`,
    `          <h1>${safeHeroTitle}</h1>`,
    `          <p className="hero__subtitle">${safeHeroSubtitle}</p>`,
    '          <button className="hero__cta">Order now</button>',
    '        </div>',
    '      </header>',
    '',
    '      <section className="features">',
    '        {cards.map((item) => (',
    '          <article key={item.title} className="card">',
    '            <h2>{item.title}</h2>',
    '            <p>{item.text}</p>',
    '          </article>',
    '        ))}',
    '      </section>',
    '    </div>',
    '  );',
    '}',
    '*** Add File: app/globals.css',
    '* {',
    '  box-sizing: border-box;',
    '}',
    '',
    'body {',
    '  margin: 0;',
    "  font-family: Inter, Arial, sans-serif;",
    '  background: #fff8f1;',
    '  color: #23170f;',
    '}',
    '',
    '.page {',
    '  min-height: 100vh;',
    '}',
    '',
    '.hero {',
    '  padding: 80px 20px 72px;',
    '  text-align: center;',
    '  background: linear-gradient(160deg, #ff7a2f 0%, #f44336 100%);',
    '  color: #fffaf6;',
    '}',
    '',
    '.hero__inner {',
    '  max-width: 860px;',
    '  margin: 0 auto;',
    '}',
    '',
    '.hero__brand {',
    '  margin: 0 0 10px;',
    '  opacity: 0.92;',
    '  letter-spacing: 0.06em;',
    '  text-transform: uppercase;',
    '  font-size: 0.83rem;',
    '}',
    '',
    '.hero h1 {',
    '  margin: 0;',
    '  font-size: clamp(2rem, 5vw, 3.5rem);',
    '  line-height: 1.06;',
    '}',
    '',
    '.hero__subtitle {',
    '  margin: 18px auto 0;',
    '  max-width: 720px;',
    '  font-size: 1.05rem;',
    '  line-height: 1.5;',
    '  opacity: 0.96;',
    '}',
    '',
    '.hero__cta {',
    '  margin-top: 26px;',
    '  border: 0;',
    '  border-radius: 999px;',
    '  padding: 13px 24px;',
    '  font-size: 1rem;',
    '  background: #fff6e9;',
    '  color: #b42614;',
    '  cursor: pointer;',
    '  font-weight: 700;',
    '}',
    '',
    '.features {',
    '  max-width: 1080px;',
    '  margin: 0 auto;',
    '  padding: 44px 20px 64px;',
    '  display: grid;',
    '  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));',
    '  gap: 16px;',
    '}',
    '',
    '.card {',
    '  background: #ffffff;',
    '  border: 1px solid #f2dfd0;',
    '  border-radius: 16px;',
    '  padding: 20px;',
    '  box-shadow: 0 10px 24px rgba(69, 27, 0, 0.07);',
    '}',
    '',
    '.card h2 {',
    '  margin: 0 0 8px;',
    '  font-size: 1.08rem;',
    '}',
    '',
    '.card p {',
    '  margin: 0;',
    '  color: #62483b;',
    '  line-height: 1.45;',
    '}',
    '*** End Patch'
  ].join('\n');
}

function createRateLimitFallbackAction(state, rawErrorMessage) {
  const hasPatchFiles = Array.isArray(state?.patchFiles) && state.patchFiles.length > 0;
  if (hasPatchFiles) {
    return {
      phase: 'deliver',
      shortStatus: 'Delivering result',
      action: {
        kind: 'final',
        message: 'Готово.'
      },
      trimmed: false
    };
  }

  if (state?.requiresPatch && !hasPatchFiles) {
    return {
      phase: 'implement',
      shortStatus: 'Implementation started',
      action: {
        kind: 'tool_call',
        tool: {
          name: 'apply_patch',
          args: {
            patch: createAutoLandingPatch(state?.messages || [])
          }
        }
      },
      trimmed: false
    };
  }

  return {
    phase: 'deliver',
    shortStatus: 'Delivering result',
    action: {
      kind: 'final',
      message: toRateLimitFinalMessage(rawErrorMessage)
    },
    trimmed: false
  };
}

export class AgentRuntime {
  constructor({ groq, modelId = DEFAULT_MODEL_ID, workspaceRoot = process.cwd() }) {
    this.groq = groq;
    this.modelId = modelId;
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  async callControllerModel(messages) {
    const { text } = await generateText({
      model: this.groq(this.modelId),
      messages,
      temperature: 0.2
    });
    return (text || '').trim();
  }

  buildControllerMessages(state, retryReason = '') {
    const policy = `You are AgentRuntime controller.
Return STRICT JSON with this schema:
{
  "phase": "plan|scan_project|implement|validate|deliver",
  "shortStatus": "one short human-readable sentence",
  "nextAction": {
    "type": "tool_call|final",
    "tool": { "name": "read_file|apply_patch|build", "args": { ... } },
    "message": "for final only"
  }
}

Rules:
- Never output arrays of tool calls.
- Never output prose around JSON.
- One response = one action.
- Reasoning must stay internal.
- shortStatus is REQUIRED for every tool_call.
- If you cannot provide shortStatus, return final instead of tool_call.
- Use read_file before apply_patch when file context is required.
- Use apply_patch once the patch is ready.
- Use build only when patch is ready or user requests build/verification.
- For build command use finite build-only command (example: "npm run build"). Never use dev/start/watch in build tool.
- For landing/frontend tasks prefer editing frontend files only (public/*, src/*, index.html, CSS/JS assets).
- Do not edit backend entry files like server.js unless user explicitly requests backend/server changes.
- Tool execution happens only after shortStatus is announced.
- When task is complete, return final.
${retryReason ? `Validation retry reason: ${retryReason}` : ''}`;

    return [{ role: 'system', content: policy }, ...state.messages];
  }

  buildFormatRepairMessages(rawResponseText) {
    const policy = `You are a JSON formatter for AgentRuntime.
Return ONLY one valid JSON object with this exact schema:
{
  "phase": "plan|scan_project|implement|validate|deliver",
  "shortStatus": "one short human-readable sentence",
  "nextAction": {
    "type": "tool_call|final",
    "tool": { "name": "read_file|apply_patch|build", "args": { ... } },
    "message": "for final only"
  }
}

Rules:
- Do not add markdown.
- Do not add explanations.
- Keep the original intent of the source text.
- If source text is unclear, return final with concise message.`;

    return [
      { role: 'system', content: policy },
      {
        role: 'user',
        content: `Reformat this response into valid schema JSON:\n\n${String(rawResponseText || '')}`
      }
    ];
  }

  async repairPatchDecisionIfNeeded(state, plannedAction, stepId, emitEvent) {
    if (plannedAction?.action?.kind !== 'tool_call' || plannedAction?.action?.tool?.name !== 'apply_patch') {
      return plannedAction;
    }

    const patch = normalizePatchText(plannedAction.action.tool.args?.patch || '');
    if (hasEditablePatchSections(patch)) {
      return plannedAction;
    }

    emitEvent(
      createStepEvent({
        type: STEP_EVENT.PROGRESS,
        runId: state.runId,
        stepId,
        stepType: 'llm',
        payload: {
          patchRepair: true,
          reason: 'invalid_patch_sections'
        }
      })
    );

    try {
      const repairReason =
        'Previous apply_patch payload had no editable sections. Return valid schema with shortStatus and nextAction.tool patch containing "*** Add/Update File: <path>" entries.';
      const raw = await this.callControllerModel(this.buildControllerMessages(state, repairReason));
      const repairedResponse = parseControllerResponse(raw);
      const narratedResponse = enforceNarrationContract({
        ...repairedResponse,
        shortStatus: repairedResponse.shortStatus || plannedAction.shortStatus
      });

      if (narratedResponse.action.kind === 'tool_call' && narratedResponse.action.tool.name === 'apply_patch') {
        const repairedPatch = normalizePatchText(narratedResponse.action.tool.args?.patch || '');
        if (!hasEditablePatchSections(repairedPatch)) {
          return createFallbackReadFileAction({
            phase: 'scan_project',
            shortStatus: 'Project structure scanned',
            path: 'package.json'
          });
        }
      }

      return narratedResponse;
    } catch {
      return createFallbackReadFileAction({
        phase: 'scan_project',
        shortStatus: 'Project structure scanned',
        path: 'package.json'
      });
    }
  }

  async resolveReadablePath(requestedPath) {
    const normalizedRequested = normalizeReadRequestPath(requestedPath);
    const candidates = [];
    const pushCandidate = (value) => {
      const normalized = normalizeReadRequestPath(value);
      if (!normalized) return;
      if (!candidates.includes(normalized)) {
        candidates.push(normalized);
      }
    };

    pushCandidate(normalizedRequested);

    if (/^index\.html$/i.test(normalizedRequested)) {
      pushCandidate('app/page.jsx');
    }
    if (/^public$/i.test(normalizedRequested)) {
      pushCandidate('app/page.jsx');
    }
    if (/^src$/i.test(normalizedRequested)) {
      pushCandidate('app/page.jsx');
      pushCandidate('components/pages/chat-page.jsx');
      pushCandidate('components/pages/home-page.jsx');
    }
    if (/\/index\.html$/i.test(normalizedRequested) && !/^public\//i.test(normalizedRequested)) {
      pushCandidate('app/page.jsx');
    }

    for (const fallbackPath of READ_FILE_FALLBACK_PATHS) {
      pushCandidate(fallbackPath);
    }

    for (const candidate of candidates) {
      let absolute;
      try {
        absolute = resolveWorkspacePath(this.workspaceRoot, candidate);
      } catch {
        continue;
      }

      try {
        await fs.stat(absolute);
        return {
          absolute,
          requestedPath: normalizedRequested,
          resolvedPath: candidate,
          redirected: candidate !== normalizedRequested
        };
      } catch {
        // continue searching readable target
      }
    }

    return {
      absolute: this.workspaceRoot,
      requestedPath: normalizedRequested,
      resolvedPath: '.',
      redirected: normalizedRequested !== '.'
    };
  }

  async runReadFile(args, emitProgress) {
    const resolved = await this.resolveReadablePath(args.path);
    const absolute = resolved.absolute;
    const relativePath = path.relative(this.workspaceRoot, absolute).replace(/\\/g, '/');
    const displayPath = resolved.resolvedPath === '.' ? '.' : relativePath || resolved.resolvedPath || '.';

    if (resolved.redirected) {
      emitProgress({
        message: `Reading ${displayPath} (fallback for ${resolved.requestedPath})`,
        path: displayPath,
        requestedPath: resolved.requestedPath,
        redirected: true
      });
    } else {
      emitProgress({
        message: `Reading ${displayPath}`,
        path: displayPath
      });
    }

    const startLine = Number.isInteger(args.startLine) && args.startLine > 0 ? args.startLine : 1;
    const stat = await fs.stat(absolute);

    if (stat.isDirectory()) {
      emitProgress({
        message: `Listing ${displayPath}`,
        path: displayPath,
        isDirectory: true
      });

      const entries = await fs.readdir(absolute, { withFileTypes: true });
      const listingLines = entries
        .sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        })
        .map((entry) => {
          const suffix = entry.isDirectory() ? '/' : '';
          const type = entry.isDirectory() ? 'dir' : 'file';
          return `[${type}] ${entry.name}${suffix}`;
        });

      const endLine =
        Number.isInteger(args.endLine) && args.endLine >= startLine
          ? Math.min(args.endLine, listingLines.length)
          : Math.min(listingLines.length, startLine + 199);

      const selected = listingLines.slice(startLine - 1, endLine).join('\n');
      const truncated = selected.length > MAX_READ_CHARS;
      const content = truncated ? `${selected.slice(0, MAX_READ_CHARS)}\n... [truncated]` : selected;

      return {
        modelResult: {
          ok: true,
          path: displayPath,
          isDirectory: true,
          startLine,
          endLine,
          totalLines: listingLines.length,
          truncated,
          content
        },
        eventPayload: {
          path: displayPath,
          isDirectory: true,
          startLine,
          endLine,
          totalLines: listingLines.length,
          entryCount: entries.length,
          charCount: content.length,
          truncated
        }
      };
    }

    const raw = await fs.readFile(absolute, 'utf8');
    const lines = raw.split('\n');
    const endLine =
      Number.isInteger(args.endLine) && args.endLine >= startLine
        ? Math.min(args.endLine, lines.length)
        : Math.min(lines.length, startLine + 199);

    const selected = lines.slice(startLine - 1, endLine).join('\n');
    const truncated = selected.length > MAX_READ_CHARS;
    const content = truncated ? `${selected.slice(0, MAX_READ_CHARS)}\n... [truncated]` : selected;

    return {
      modelResult: {
        ok: true,
        path: displayPath,
        startLine,
        endLine,
        totalLines: lines.length,
        truncated,
        content
      },
      eventPayload: {
        path: displayPath,
        startLine,
        endLine,
        totalLines: lines.length,
        charCount: content.length,
        truncated
      }
    };
  }

  async applyPatchToWorkspace(patchText) {
    const sections = parsePatchWriteSections(patchText);
    if (!sections.length) {
      return [];
    }

    const staged = new Map();

    for (const section of sections) {
      const relativePath = sanitizePatchPath(section.path);
      if (!relativePath) {
        continue;
      }

      const absolute = resolveWorkspacePath(this.workspaceRoot, relativePath);

      if (section.action === 'updated' && section.diffLike && Array.isArray(section.hunks) && section.hunks.length > 0) {
        let baseContent = '';
        if (staged.has(relativePath)) {
          baseContent = staged.get(relativePath) || '';
        } else {
          try {
            baseContent = await fs.readFile(absolute, 'utf8');
          } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
              throw error;
            }
            baseContent = '';
          }
        }
        staged.set(relativePath, applyPatchHunks(baseContent, section.hunks));
      } else {
        staged.set(relativePath, normalizeLF(String(section.content || '')));
      }
    }

    const writtenPaths = [];
    for (const [relativePath, content] of staged.entries()) {
      const absolute = resolveWorkspacePath(this.workspaceRoot, relativePath);
      try {
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, content, 'utf8');
        writtenPaths.push(relativePath);
      } catch (error) {
        if (isReadOnlyFsError(error)) {
          return {
            writtenPaths,
            workspaceApplied: false,
            skippedReadOnly: true
          };
        }
        throw error;
      }
    }

    return {
      writtenPaths,
      workspaceApplied: true,
      skippedReadOnly: false
    };
  }

  async runApplyPatch(args, emitProgress) {
    const rawPatch = typeof args.patch === 'string' ? args.patch : '';
    const hadEscapedNewlines = rawPatch.includes('\\n');
    const hadLineContinuationArtifact = /\\\s*(?:\r?\n|$)/.test(rawPatch);
    const patch = normalizePatchText(rawPatch);
    if (!patch) {
      throw new Error('Tool "apply_patch" requires non-empty "patch" string.');
    }

    const files = parsePatchFiles(patch);
    if (!files.length) {
      throw new Error(
        'Patch has no editable files. Use "*** Add File" or "*** Update File" (Create is also accepted).'
      );
    }

    emitProgress({
      message: `Parsed patch for ${files.length} file(s).`,
      fileCount: files.length,
      normalized: true,
      hadEscapedNewlines,
      hadLineContinuationArtifact
    });

    const applyResult = await this.applyPatchToWorkspace(patch);
    if (applyResult.skippedReadOnly) {
      emitProgress({
        message: 'Workspace is read-only; patch stored for preview sync.',
        writtenFileCount: applyResult.writtenPaths.length,
        skippedReadOnly: true
      });
    } else {
      emitProgress({
        message: `Applied patch to workspace (${applyResult.writtenPaths.length} file(s)).`,
        writtenFileCount: applyResult.writtenPaths.length
      });
    }

    return {
      modelResult: {
        ok: true,
        files,
        fileCount: files.length,
        patchStored: true,
        workspaceApplied: applyResult.workspaceApplied
      },
      eventPayload: {
        fileCount: files.length,
        files,
        writtenFileCount: applyResult.writtenPaths.length,
        workspaceApplied: applyResult.workspaceApplied,
        skippedReadOnly: applyResult.skippedReadOnly
      },
      statePatch: patch,
      statePatchFiles: files
    };
  }

  async runBuild(args, emitProgress) {
    const normalized = normalizeBuildCommand(args.command);
    const command = normalized.command;

    emitProgress({
      message: `Running ${command}`,
      command,
      normalizedCommand: normalized.normalized,
      normalizeReason: normalized.reason || null
    });

    const { stdout, stderr } = await exec(command, {
      cwd: this.workspaceRoot,
      timeout: BUILD_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024
    });

    return {
      modelResult: {
        ok: true,
        command,
        normalizedCommand: normalized.normalized,
        normalizeReason: normalized.reason || null,
        stdout: safeTail(stdout, 3000),
        stderr: safeTail(stderr, 1200)
      },
      eventPayload: {
        command,
        normalizedCommand: normalized.normalized,
        normalizeReason: normalized.reason || null,
        ok: true,
        stdoutTail: safeTail(stdout, 600),
        stderrTail: safeTail(stderr, 400)
      }
    };
  }

  async executeTool(toolCall, emitProgress) {
    const name = String(toolCall?.name || '').trim();
    const args = toolCall?.args && typeof toolCall.args === 'object' ? toolCall.args : {};

    if (name === 'read_file') {
      return this.runReadFile(args, emitProgress);
    }

    if (name === 'apply_patch') {
      return this.runApplyPatch(args, emitProgress);
    }

    if (name === 'build') {
      return this.runBuild(args, emitProgress);
    }

    throw new Error(`Unknown tool: ${name || '<empty>'}`);
  }

  createGraph(emitEvent) {
    const graph = new StateGraph(RUNTIME_STATE)
      .addNode('llm', async (state) => {
        const stepId = `step-${state.stepCount + 1}`;
        const iteration = state.llmIterations + 1;
        const currentNoPatchRetries = Number.isInteger(state.noPatchRetries) ? state.noPatchRetries : 0;
        let noPatchRetries = currentNoPatchRetries;
        const stepStartedAt = Date.now();

        emitEvent(
          createStepEvent({
            type: STEP_EVENT.STARTED,
            runId: state.runId,
            stepId,
            stepType: 'llm',
            payload: {
              iteration,
              phase: iteration === 1 ? 'plan' : 'implement',
              shortStatus: iteration === 1 ? 'Entered plan mode' : 'Planning next action',
              display: toDisplayPayload({
                stepId,
                stepType: 'llm',
                phase: iteration === 1 ? 'plan' : 'implement',
                shortStatus: 'Thought',
                state: 'running'
              })
            }
          })
        );

        emitEvent(
          createStepEvent({
            type: STEP_EVENT.PROGRESS,
            runId: state.runId,
            stepId,
            stepType: 'llm',
            payload: {
              phase: 'requesting_decision'
            }
          })
        );

        if (iteration > MAX_LLM_ITERATIONS) {
          const message = `Остановлено по лимиту шагов (${MAX_LLM_ITERATIONS}).`;
          await ensureMinStepDuration(stepStartedAt);
          emitEvent(
            createStepEvent({
              type: STEP_EVENT.COMPLETED,
              runId: state.runId,
              stepId,
              stepType: 'llm',
              payload: {
                decision: 'final',
                reason: 'max_iterations',
                message,
                phase: 'deliver',
                shortStatus: 'Delivering result',
                display: toDisplayPayload({
                  stepId,
                  stepType: 'llm',
                  phase: 'deliver',
                  shortStatus: 'Thought',
                  state: 'completed'
                })
              }
            })
          );

          return {
            stepCount: state.stepCount + 1,
            llmIterations: iteration,
            noPatchRetries: currentNoPatchRetries,
            pendingTool: null,
            pendingPhase: '',
            pendingShortStatus: '',
            finalMessage: message,
            shouldStop: true
          };
        }

        let raw = '';
        let plannedAction;

        try {
          raw = await this.callControllerModel(this.buildControllerMessages(state));
          plannedAction = enforceNarrationContract(parseControllerResponse(raw));
        } catch (firstError) {
          const firstErrorMessage = firstError instanceof Error ? firstError.message : String(firstError || '');
          if (isRateLimitErrorMessage(firstErrorMessage)) {
            plannedAction = createRateLimitFallbackAction(state, firstErrorMessage);
          } else {
            emitEvent(
              createStepEvent({
                type: STEP_EVENT.PROGRESS,
                runId: state.runId,
                stepId,
                stepType: 'llm',
                payload: {
                  validationRetry: true,
                  reason: firstErrorMessage || 'Unknown parse error'
                }
              })
            );

            try {
              raw = await this.callControllerModel(
                this.buildControllerMessages(
                  state,
                  'Previous response was invalid. Provide phase + shortStatus + nextAction. If nextAction is tool_call, shortStatus is required before execution.'
                )
              );
            } catch (retryCallError) {
              const retryCallMessage = retryCallError instanceof Error ? retryCallError.message : String(retryCallError || '');
              if (isRateLimitErrorMessage(retryCallMessage)) {
                plannedAction = createRateLimitFallbackAction(state, retryCallMessage);
              } else {
                throw retryCallError;
              }
            }

            if (!plannedAction) {
              try {
                plannedAction = enforceNarrationContract(parseControllerResponse(raw));
              } catch (secondError) {
                emitEvent(
                  createStepEvent({
                    type: STEP_EVENT.PROGRESS,
                    runId: state.runId,
                    stepId,
                    stepType: 'llm',
                    payload: {
                      validationRepair: true,
                      reason: secondError instanceof Error ? secondError.message : 'Unknown parse error'
                    }
                  })
                );

                try {
                  const repairedRaw = await this.callControllerModel(this.buildFormatRepairMessages(raw));
                  plannedAction = enforceNarrationContract(parseControllerResponse(repairedRaw));
                } catch (thirdError) {
                  const thirdErrorMessage = thirdError instanceof Error ? thirdError.message : String(thirdError || '');
                  if (isRateLimitErrorMessage(thirdErrorMessage)) {
                    plannedAction = createRateLimitFallbackAction(state, thirdErrorMessage);
                  } else {
                    emitEvent(
                      createStepEvent({
                        type: STEP_EVENT.PROGRESS,
                        runId: state.runId,
                        stepId,
                        stepType: 'llm',
                        payload: {
                          validationFallback: true,
                          reason: thirdErrorMessage || 'Unknown parse error'
                        }
                      })
                    );

                    if (iteration === 1 || state.requiresPatch) {
                      plannedAction = {
                        phase: 'scan_project',
                        shortStatus: 'Project structure scanned',
                        action: {
                          kind: 'tool_call',
                          tool: {
                            name: 'read_file',
                            args: {
                              path: 'package.json',
                              startLine: 1,
                              endLine: 260
                            }
                          }
                        },
                        trimmed: false
                      };
                    } else {
                      plannedAction = {
                        phase: 'deliver',
                        shortStatus: 'Delivering result',
                        action: {
                          kind: 'final',
                          message: toSafeFinalFallback(raw)
                        },
                        trimmed: false
                      };
                    }
                  }
                }
              }
            }
          }
        }

        plannedAction = await this.repairPatchDecisionIfNeeded(state, plannedAction, stepId, emitEvent);

        if (plannedAction.trimmed) {
          emitEvent(
            createStepEvent({
              type: STEP_EVENT.PROGRESS,
              runId: state.runId,
              stepId,
              stepType: 'llm',
              payload: {
                policy: 'multiple_tool_calls_trimmed',
                kept: plannedAction.action?.tool?.name || 'unknown'
              }
            })
          );
        }

        const hasPatchFiles = Array.isArray(state.patchFiles) && state.patchFiles.length > 0;
        if (plannedAction.action.kind === 'final' && state.requiresPatch && !hasPatchFiles) {
          noPatchRetries += 1;
          emitEvent(
            createStepEvent({
              type: STEP_EVENT.PROGRESS,
              runId: state.runId,
              stepId,
              stepType: 'llm',
              payload: {
                validationRetry: true,
                reason: 'final_without_patch',
                requiresPatch: true,
                attempt: noPatchRetries
              }
            })
          );

          if (noPatchRetries >= 2) {
            const autoPatch = createAutoLandingPatch(state.messages);
            plannedAction = {
              phase: 'implement',
              shortStatus: 'Implementation started',
              action: {
                kind: 'tool_call',
                tool: {
                  name: 'apply_patch',
                  args: {
                    patch: autoPatch
                  }
                }
              },
              trimmed: false
            };
          } else {
            try {
              const recoveryRaw = await this.callControllerModel(
                this.buildControllerMessages(
                  state,
                  'Task requires code changes. Do not finalize without at least one valid apply_patch action containing Add/Update File sections.'
                )
              );
              const recoveredAction = enforceNarrationContract(parseControllerResponse(recoveryRaw));
              plannedAction = await this.repairPatchDecisionIfNeeded(state, recoveredAction, stepId, emitEvent);
            } catch {
              plannedAction = createFallbackReadFileAction({
                phase: 'scan_project',
                shortStatus: 'Project structure scanned',
                path: 'package.json'
              });
            }
          }
        }

        if (plannedAction.action.kind === 'tool_call') {
          const nextPhase = normalizePhase(plannedAction.phase, phaseForTool(plannedAction.action.tool.name));
          const shortStatus = plannedAction.shortStatus;
          if (plannedAction.action.tool.name === 'apply_patch') {
            noPatchRetries = 0;
          }
          await ensureMinStepDuration(stepStartedAt);
          emitEvent(
            createStepEvent({
              type: STEP_EVENT.COMPLETED,
              runId: state.runId,
              stepId,
              stepType: 'llm',
              payload: {
                decision: 'tool_call',
                toolName: plannedAction.action.tool.name,
                phase: nextPhase,
                shortStatus,
                display: toDisplayPayload({
                  stepId,
                  stepType: 'llm',
                  phase: nextPhase,
                  shortStatus: 'Thought',
                  state: 'completed'
                })
              }
            })
          );

          const assistantRecord = {
            role: 'assistant',
            content: JSON.stringify({
              type: 'tool_call',
              phase: nextPhase,
              shortStatus,
              tool: plannedAction.action.tool
            })
          };

          return {
            stepCount: state.stepCount + 1,
            llmIterations: iteration,
            noPatchRetries,
            pendingTool: plannedAction.action.tool,
            pendingPhase: nextPhase,
            pendingShortStatus: shortStatus,
            messages: state.messages.concat(assistantRecord),
            shouldStop: false
          };
        }

        const finalMessage = plannedAction.action.message || 'Готово.';
        const finalPhase = normalizePhase(plannedAction.phase, 'deliver');
        const finalShortStatus = plannedAction.shortStatus || 'Delivering result';

        await ensureMinStepDuration(stepStartedAt);
        emitEvent(
          createStepEvent({
            type: STEP_EVENT.COMPLETED,
            runId: state.runId,
            stepId,
              stepType: 'llm',
              payload: {
                decision: 'final',
                phase: finalPhase,
                shortStatus: finalShortStatus,
                display: toDisplayPayload({
                  stepId,
                  stepType: 'llm',
                  phase: finalPhase,
                  shortStatus: 'Thought',
                  state: 'completed'
                })
              }
            })
          );

        return {
          stepCount: state.stepCount + 1,
          llmIterations: iteration,
          noPatchRetries,
          pendingTool: null,
          pendingPhase: '',
          pendingShortStatus: '',
          finalMessage,
          shouldStop: true
        };
      })
      .addNode('tool', async (state) => {
        const stepId = `step-${state.stepCount + 1}`;
        const toolCall = state.pendingTool || { name: 'unknown', args: {} };
        const stepType = mapStepTypeForTool(toolCall.name);
        const phase = normalizePhase(state.pendingPhase, phaseForTool(toolCall.name));
        const shortStatus =
          typeof state.pendingShortStatus === 'string' && state.pendingShortStatus.trim()
            ? state.pendingShortStatus.trim()
            : shortStatusForTool(toolCall.name);
        const stepStartedAt = Date.now();

        emitEvent(
          createStepEvent({
            type: STEP_EVENT.STARTED,
            runId: state.runId,
            stepId,
            stepType,
            payload: {
              toolName: toolCall.name,
              args: toolCall.args || {},
              phase,
              shortStatus,
              display: toDisplayPayload({
                stepId,
                stepType,
                phase,
                shortStatus,
                state: 'running'
              })
            }
          })
        );

        emitEvent(
          createStepEvent({
            type: STEP_EVENT.PROGRESS,
            runId: state.runId,
            stepId,
            stepType,
            payload: {
              phase: 'executing_tool'
            }
          })
        );

        try {
          const result = await this.executeTool(toolCall, (payload) => {
            emitEvent(
              createStepEvent({
                type: STEP_EVENT.PROGRESS,
                runId: state.runId,
                stepId,
                stepType,
                payload
              })
            );
          });

          await ensureMinStepDuration(stepStartedAt);
          emitEvent(
            createStepEvent({
              type: STEP_EVENT.COMPLETED,
              runId: state.runId,
              stepId,
              stepType,
              payload: {
                ...(result.eventPayload || {}),
                phase,
                shortStatus,
                display: toDisplayPayload({
                  stepId,
                  stepType,
                  phase,
                  shortStatus,
                  state: 'completed'
                })
              }
            })
          );

          const toolResultMessage = {
            role: 'user',
            content: JSON.stringify({
              type: 'tool_result',
              tool: toolCall.name,
              result: result.modelResult
            })
          };

          return {
            stepCount: state.stepCount + 1,
            pendingTool: null,
            pendingPhase: '',
            pendingShortStatus: '',
            messages: state.messages.concat(toolResultMessage),
            patchText:
              typeof result.statePatch === 'string'
                ? mergePatchText(state.patchText, result.statePatch)
                : state.patchText,
            patchFiles:
              Array.isArray(result.statePatchFiles) && result.statePatchFiles.length
                ? mergePatchFiles(state.patchFiles, result.statePatchFiles)
                : state.patchFiles
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown tool error';

          await ensureMinStepDuration(stepStartedAt);
          emitEvent(
            createStepEvent({
              type: STEP_EVENT.ERROR,
              runId: state.runId,
              stepId,
              stepType,
              payload: {
                toolName: toolCall.name,
                message,
                phase,
                shortStatus,
                display: toDisplayPayload({
                  stepId,
                  stepType,
                  phase,
                  shortStatus,
                  state: 'error',
                  details: message
                })
              }
            })
          );

          const toolResultMessage = {
            role: 'user',
            content: JSON.stringify({
              type: 'tool_result',
              tool: toolCall.name,
              result: { ok: false, message }
            })
          };

          return {
            stepCount: state.stepCount + 1,
            pendingTool: null,
            pendingPhase: '',
            pendingShortStatus: '',
            messages: state.messages.concat(toolResultMessage)
          };
        }
      })
      .addNode('finish', async (state) => {
        const stepId = `step-${state.stepCount + 1}`;
        const stepStartedAt = Date.now();

        emitEvent(
          createStepEvent({
            type: STEP_EVENT.STARTED,
            runId: state.runId,
            stepId,
            stepType: 'finish',
            payload: {
              phase: 'deliver',
              shortStatus: 'Delivering result',
              display: toDisplayPayload({
                stepId,
                stepType: 'finish',
                phase: 'deliver',
                shortStatus: 'Delivering result',
                state: 'running'
              })
            }
          })
        );

        emitEvent(
          createStepEvent({
            type: STEP_EVENT.PROGRESS,
            runId: state.runId,
            stepId,
            stepType: 'finish',
            payload: {
              phase: 'finalizing'
            }
          })
        );

        await ensureMinStepDuration(stepStartedAt);
        emitEvent(
          createStepEvent({
            type: STEP_EVENT.COMPLETED,
            runId: state.runId,
            stepId,
            stepType: 'finish',
            payload: {
              message: state.finalMessage || 'Готово.',
              patch: state.patchText || '',
              files: state.patchFiles || [],
              phase: 'deliver',
              shortStatus: 'Delivered',
              display: toDisplayPayload({
                stepId,
                stepType: 'finish',
                phase: 'deliver',
                shortStatus: 'Delivered',
                state: 'completed'
              })
            }
          })
        );

        return {
          stepCount: state.stepCount + 1
        };
      })
      .addEdge(START, 'llm')
      .addConditionalEdges('llm', (state) => (state.shouldStop ? 'finish' : 'tool'), {
        tool: 'tool',
        finish: 'finish'
      })
      .addEdge('tool', 'llm')
      .addEdge('finish', END);

    return graph.compile();
  }

  async *runStream(messages) {
    const runId = randomUUID();
    const initialMessages = normalizeMessages(messages);
    const requiresPatch = requiresPatchForMessages(initialMessages);
    const queue = new AsyncEventQueue();

    const emitEvent = (event) => {
      queue.push(event);
    };

    (async () => {
      try {
        emitEvent(
          createRunEvent({
            type: RUN_EVENT.STARTED,
            runId,
            payload: {
              model: this.modelId
            }
          })
        );

        const graph = this.createGraph(emitEvent);

        const finalState = await graph.invoke(
          {
            runId,
            messages: initialMessages,
            stepCount: 0,
            llmIterations: 0,
            pendingTool: null,
            pendingPhase: '',
            pendingShortStatus: '',
            finalMessage: '',
            patchText: '',
            patchFiles: [],
            shouldStop: false,
            requiresPatch
          },
          {
            recursionLimit: Math.max(80, MAX_LLM_ITERATIONS * 8)
          }
        );

        emitEvent(
          createRunEvent({
            type: RUN_EVENT.COMPLETED,
            runId,
            payload: {
              steps: Number.isInteger(finalState?.stepCount) ? finalState.stepCount : null
            }
          })
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown runtime error';
        emitEvent(
          createRunEvent({
            type: RUN_EVENT.ERROR,
            runId,
            payload: {
              message
            }
          })
        );
        emitEvent(
          createStepEvent({
            type: STEP_EVENT.ERROR,
            runId,
            stepId: 'step-fatal',
            stepType: 'runtime',
            payload: {
              message,
              display: toDisplayPayload({
                stepId: 'step-fatal',
                stepType: 'runtime',
                phase: 'deliver',
                shortStatus: 'Runtime error',
                state: 'error',
                details: message
              })
            }
          })
        );
      } finally {
        queue.close();
      }
    })();

    for await (const event of queue.stream()) {
      yield event;
    }
  }

  async run(messages) {
    const events = [];

    for await (const event of this.runStream(messages)) {
      events.push(event);
    }

    const finishEvent = [...events]
      .reverse()
      .find((item) => item.type === STEP_EVENT.COMPLETED && item.stepType === 'finish');

    return {
      runId: events[0]?.runId || randomUUID(),
      content: finishEvent?.payload?.message || 'Готово.',
      code: typeof finishEvent?.payload?.patch === 'string' ? finishEvent.payload.patch : '',
      patchFiles: Array.isArray(finishEvent?.payload?.files) ? finishEvent.payload.files : [],
      events
    };
  }
}
