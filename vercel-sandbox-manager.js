import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { setTimeout as sleep } from 'timers/promises';
import { Writable } from 'stream';
import { Sandbox } from '@vercel/sandbox';

const DEFAULT_PREVIEW_PORT = 3000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_IDLE_TTL_MS = 45 * 60 * 1000;
const DEFAULT_MAX_VALIDATE_ATTEMPTS = Math.min(
  6,
  Math.max(1, Number.parseInt(process.env.MAX_VALIDATE_ATTEMPTS || '4', 10) || 4)
);
const MAX_LOG_LINES = 220;
const MAX_OPERATIONS = 64;
const MAX_CANVAS_CHARS = 22000;
const WORKSPACE_ROOT = '/vercel/sandbox';
const SANDBOX_HOME = `${WORKSPACE_ROOT}/.home`;
const SANDBOX_NPM_CACHE = `${WORKSPACE_ROOT}/.npm-cache`;
const HEALTHCHECK_MAX_ATTEMPTS = 60;
const HEALTHCHECK_INTERVAL_MS = 1000;

function tailLines(text, maxLines = 80, maxChars = 5000) {
  const normalized = normalizeLF(String(text || '')).trim();
  if (!normalized) {
    return '';
  }

  const lines = normalized.split('\n');
  const slice = lines.slice(-maxLines).join('\n');
  if (slice.length <= maxChars) {
    return slice;
  }
  return slice.slice(-maxChars);
}

function cleanSummaryMessage(text) {
  const normalized = normalizeLF(String(text || ''))
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) {
    return 'Unknown failure.';
  }
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}

function getExplicitSandboxCredentials() {
  const token = typeof process.env.VERCEL_TOKEN === 'string' ? process.env.VERCEL_TOKEN.trim() : '';
  const teamId = typeof process.env.VERCEL_TEAM_ID === 'string' ? process.env.VERCEL_TEAM_ID.trim() : '';
  const projectId = typeof process.env.VERCEL_PROJECT_ID === 'string' ? process.env.VERCEL_PROJECT_ID.trim() : '';

  if (!token || !teamId || !projectId) {
    return null;
  }

  return {
    token,
    teamId,
    projectId
  };
}

function normalizeLF(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function decodeEscapedMultiline(text) {
  let next = String(text || '');
  const hasRealNewlines = /[\r\n]/.test(next);
  const hasEscapedNewlines = /\\r\\n|\\n|\\r/.test(next);
  if (hasRealNewlines || !hasEscapedNewlines) {
    return next;
  }

  for (let i = 0; i < 4; i += 1) {
    const decoded = next
      .replace(/(?<!\\)\\r\\n/g, '\n')
      .replace(/(?<!\\)\\n/g, '\n')
      .replace(/(?<!\\)\\r/g, '\n');

    if (decoded === next) {
      break;
    }
    next = decoded;
    if (/[\r\n]/.test(next)) {
      break;
    }
  }

  return next;
}

function stripContinuationArtifacts(text) {
  const normalized = normalizeLF(text);
  const lines = normalized.split('\n');
  if (!lines.length) {
    return normalized;
  }

  const trailingSlashCount = lines.filter((line) => /\\\s*$/.test(line)).length;
  if (trailingSlashCount / lines.length < 0.25) {
    return normalized;
  }

  return lines.map((line) => line.replace(/\\\s*$/, '')).join('\n');
}

function normalizeTextContent(raw) {
  const decoded = decodeEscapedMultiline(raw);
  const withLf = normalizeLF(decoded);
  return stripContinuationArtifacts(withLf);
}

function sanitizePatchPath(rawPath) {
  let filePath = String(rawPath || '').trim();
  if (!filePath) {
    return '';
  }

  filePath = filePath.replace(/^['"`]+|['"`]+$/g, '');
  filePath = filePath.replace(/\\/g, '/');
  filePath = filePath.replace(/\/+/g, '/');
  filePath = filePath.replace(/^\/+/, '');
  filePath = filePath.replace(/\/+$/, '');
  filePath = filePath.replace(/^\.\//, '');

  if (!filePath || filePath.includes('..')) {
    return '';
  }

  return filePath;
}

function extractPatchEnvelope(rawPatch) {
  const raw = String(rawPatch || '');
  const match = raw.match(/\*\*\* Begin Patch[\s\S]*?(?:\*\*\* End Patch|$)/);
  return match ? match[0] : raw;
}

function extractPatchEnvelopes(rawPatch) {
  const raw = String(rawPatch || '');
  const matches = raw.match(/\*\*\* Begin Patch[\s\S]*?(?:\*\*\* End Patch|$)/g);
  if (matches && matches.length) {
    return matches;
  }
  return [raw];
}

function sectionBodyToContent(body) {
  const normalizedBody = normalizeLF(String(body || ''));
  const lines = normalizedBody.split('\n');

  const hasHunkMarkers = lines.some((line) => line.startsWith('@@'));
  const diffPrefixedLines = lines.filter((line) => /^[ +\-]/.test(line)).length;
  const diffLike = hasHunkMarkers || diffPrefixedLines / Math.max(lines.length, 1) >= 0.7;

  if (!diffLike) {
    return stripPatchControlLines(normalizedBody);
  }

  const output = [];
  for (const line of lines) {
    if (!line) {
      output.push('');
      continue;
    }

    if (line.startsWith('@@')) {
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('\\ No newline at end of file')) {
      continue;
    }

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

  return stripPatchControlLines(output.join('\n'));
}

function parseUnifiedDiffHunks(body) {
  const lines = normalizeLF(String(body || '')).split('\n');
  const hunks = [];
  let current = null;

  for (const line of lines) {
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (header) {
      if (current) {
        hunks.push(current);
      }
      current = {
        oldStart: Number.parseInt(header[1], 10) || 1,
        oldCount: Number.parseInt(header[2] || '1', 10) || 1,
        newStart: Number.parseInt(header[3], 10) || 1,
        newCount: Number.parseInt(header[4] || '1', 10) || 1,
        lines: []
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith('\\ No newline at end of file')) {
      continue;
    }

    const op = line[0];
    if (op === ' ' || op === '+' || op === '-') {
      current.lines.push({ op, text: line.slice(1) });
      continue;
    }

    current.lines.push({ op: ' ', text: line });
  }

  if (current) {
    hunks.push(current);
  }

  return hunks;
}

function applyUnifiedHunks(baseContent, hunks) {
  const sourceText = normalizeLF(String(baseContent || ''));
  const source = sourceText === '' ? [] : sourceText.split('\n');
  const output = [];
  let cursor = 0;

  for (const hunk of Array.isArray(hunks) ? hunks : []) {
    let oldIndex = Math.max(0, Number.parseInt(String(hunk?.oldStart || '1'), 10) - 1);
    if (!Number.isFinite(oldIndex)) {
      oldIndex = cursor;
    }
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
        if (cursor < source.length) {
          cursor += 1;
        }
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

function stripPatchControlLines(text) {
  const lines = normalizeLF(text).split('\n');
  const filtered = lines.filter(
    (line) =>
      !/^\s*\*\*\*\s+(?:Begin Patch|End Patch|Add File:|Update File:|Create File:|Delete File:|Move to:)\b/.test(line)
  );

  return filtered.join('\n').trimEnd();
}

function parsePatchSections(rawPatch) {
  const envelopes = extractPatchEnvelopes(rawPatch);
  const normalizedPatch = normalizeTextContent(envelopes.join('\n\n')).trim();
  if (!normalizedPatch) {
    return [];
  }

  const fileRegex =
    /(?:^|\n)\*\*\* (Add|Update|Create) File: ([^\n]+)\n([\s\S]*?)(?=(?:\n\*\*\* (?:Add|Update|Create) File: )|\n\*\*\* End Patch|$)/g;

  const sections = [];
  let match;

  while ((match = fileRegex.exec(normalizedPatch)) !== null) {
    const actionRaw = match[1];
    const rawPath = match[2];
    const body = match[3] || '';

    const path = sanitizePatchPath(rawPath);
    if (!path) {
      continue;
    }

    const normalizedBody = normalizeLF(String(body || ''));
    const content = sectionBodyToContent(normalizedBody);
    const hunks = actionRaw === 'Update' ? parseUnifiedDiffHunks(normalizedBody) : [];

    sections.push({
      action: actionRaw === 'Update' ? 'updated' : 'added',
      path,
      content,
      hunks,
      diffLike: hunks.length > 0
    });
  }

  return sections;
}

function toSandboxPath(relativePath) {
  return `${WORKSPACE_ROOT}/${relativePath}`;
}

function nowIso() {
  return new Date().toISOString();
}

function inferLanguageFromPath(filePath) {
  const normalized = String(filePath || '').toLowerCase();
  if (normalized.endsWith('.tsx')) return 'tsx';
  if (normalized.endsWith('.ts')) return 'ts';
  if (normalized.endsWith('.jsx')) return 'jsx';
  if (normalized.endsWith('.js') || normalized.endsWith('.mjs') || normalized.endsWith('.cjs')) return 'js';
  if (normalized.endsWith('.css')) return 'css';
  if (normalized.endsWith('.html') || normalized.endsWith('.htm')) return 'html';
  if (normalized.endsWith('.json')) return 'json';
  if (normalized.endsWith('.md')) return 'markdown';
  return 'text';
}

function resolveCanvasSection(sections) {
  const files = Array.isArray(sections) ? sections : [];
  if (!files.length) {
    return null;
  }

  const preferred = files.find((item) => /^src\/App\.(tsx|ts|jsx|js|vue|svelte)$/i.test(item.path));
  return preferred || files[files.length - 1] || null;
}

function truncateForCanvas(text) {
  const raw = String(text || '');
  if (raw.length <= MAX_CANVAS_CHARS) {
    return raw;
  }
  return `${raw.slice(0, MAX_CANVAS_CHARS)}\n\n/* ...truncated */`;
}

function createEmptyState(sessionId) {
  return {
    sessionId,
    status: 'idle',
    url: null,
    sandboxId: null,
    operations: [],
    canvas: null,
    logs: [],
    error: null,
    updatedAt: nowIso()
  };
}

export class VercelSandboxManager {
  constructor({
    port = DEFAULT_PREVIEW_PORT,
    runtime = process.env.SANDBOX_RUNTIME || 'node22',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    idleTtlMs = DEFAULT_IDLE_TTL_MS,
    maxValidateAttempts = DEFAULT_MAX_VALIDATE_ATTEMPTS
  } = {}) {
    this.port = port;
    this.runtime = runtime;
    this.timeoutMs = timeoutMs;
    this.idleTtlMs = idleTtlMs;
    this.maxValidateAttempts = Math.max(1, Number.parseInt(String(maxValidateAttempts), 10) || DEFAULT_MAX_VALIDATE_ATTEMPTS);
    this.sessions = new Map();

    this.cleanupTimer = setInterval(() => {
      this.cleanupIdleSessions().catch(() => {});
    }, 60_000);

    if (typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  appendLog(session, line) {
    const normalized = normalizeLF(String(line || '')).split('\n');
    for (const entry of normalized) {
      if (!entry.trim()) {
        continue;
      }
      session.logs.push(entry);
    }

    if (session.logs.length > MAX_LOG_LINES) {
      session.logs.splice(0, session.logs.length - MAX_LOG_LINES);
    }
  }

  setStatus(session, status, error = null) {
    session.status = status;
    session.error = error;
    session.updatedAt = nowIso();
    session.lastTouchedAt = Date.now();
  }

  pushOperation(session, operation) {
    session.operations.push(operation);
    if (session.operations.length > MAX_OPERATIONS) {
      session.operations.splice(0, session.operations.length - MAX_OPERATIONS);
    }
    session.updatedAt = nowIso();
    session.lastTouchedAt = Date.now();
  }

  startOperation(session, { kind, label, filePath = null }) {
    const operation = {
      id: randomUUID(),
      kind: String(kind || 'task'),
      label: String(label || 'Working'),
      state: 'running',
      filePath: typeof filePath === 'string' && filePath ? filePath : null,
      startedAt: nowIso(),
      finishedAt: null
    };
    this.pushOperation(session, operation);
    return operation.id;
  }

  completeOperation(session, operationId) {
    const operation = session.operations.find((item) => item.id === operationId);
    if (!operation || operation.state !== 'running') {
      return;
    }
    operation.state = 'completed';
    operation.finishedAt = nowIso();
    session.updatedAt = operation.finishedAt;
  }

  failOperation(session, operationId, errorMessage) {
    const operation = session.operations.find((item) => item.id === operationId);
    if (!operation || operation.state !== 'running') {
      return;
    }
    operation.state = 'error';
    operation.error = String(errorMessage || 'Unknown error');
    operation.finishedAt = nowIso();
    session.updatedAt = operation.finishedAt;
  }

  async runOperation(session, descriptor, fn) {
    const operationId = this.startOperation(session, descriptor);
    try {
      const result = await fn();
      this.completeOperation(session, operationId);
      return result;
    } catch (error) {
      this.failOperation(session, operationId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  updateCanvasSnapshot(session, sections) {
    const selected = resolveCanvasSection(sections);
    if (!selected) {
      return;
    }

    session.canvasSnapshot = {
      filePath: selected.path,
      language: inferLanguageFromPath(selected.path),
      content: truncateForCanvas(normalizeTextContent(selected.content || '')),
      updatedAt: nowIso()
    };
  }

  toPublicState(session, extra = {}) {
    return {
      sessionId: session.sessionId,
      status: session.status,
      url: session.url || null,
      sandboxId: session.sandbox?.sandboxId || null,
      operations: session.operations.slice(-24),
      canvas: session.canvasSnapshot ? { ...session.canvasSnapshot } : null,
      logs: session.logs.slice(-80),
      error: session.error,
      updatedAt: session.updatedAt,
      ...extra
    };
  }

  getOrCreateSession(sessionId) {
    const safeSessionId = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : randomUUID();
    const existing = this.sessions.get(safeSessionId);
    if (existing) {
      existing.lastTouchedAt = Date.now();
      return existing;
    }

    const session = {
      sessionId: safeSessionId,
      sandbox: null,
      status: 'idle',
      url: null,
      error: null,
      logs: [],
      updatedAt: nowIso(),
      lastTouchedAt: Date.now(),
      queue: Promise.resolve(),
      devCommand: null,
      dependenciesInstalled: false,
      skipBuild: false,
      packageManager: null,
      packageManagerSpec: null,
      runtimeFingerprintCaptured: false,
      operations: [],
      canvasSnapshot: null
    };

    this.sessions.set(safeSessionId, session);
    return session;
  }

  async ensureSandbox(session) {
    if (session.sandbox) {
      return session.sandbox;
    }

    this.setStatus(session, 'provisioning');
    this.appendLog(session, '[sandbox] Creating Vercel Sandbox...');

    const explicitCredentials = getExplicitSandboxCredentials();

    const sandbox = await Sandbox.create({
      runtime: this.runtime,
      timeout: this.timeoutMs,
      ports: [this.port],
      ...(explicitCredentials || {})
    });

    const route = Array.isArray(sandbox.routes)
      ? sandbox.routes.find((item) => Number(item?.port) === Number(this.port))
      : null;
    const routeUrl = typeof route?.url === 'string' ? route.url.trim() : '';
    const fallbackUrl = sandbox.domain(this.port);
    const publicUrl = routeUrl || fallbackUrl;

    session.sandbox = sandbox;
    session.url = /^https?:\/\//i.test(publicUrl) ? publicUrl : `https://${publicUrl.replace(/^\/+/, '')}`;
    this.appendLog(session, `[sandbox] Created ${sandbox.sandboxId}`);

    await sandbox.mkDir(`${WORKSPACE_ROOT}/src`).catch(() => {});
    await sandbox.mkDir(SANDBOX_HOME).catch(() => {});
    await sandbox.mkDir(SANDBOX_NPM_CACHE).catch(() => {});

    return sandbox;
  }

  buildSandboxEnv(extraEnv = {}) {
    return {
      HOME: SANDBOX_HOME,
      USERPROFILE: SANDBOX_HOME,
      npm_config_cache: SANDBOX_NPM_CACHE,
      npm_config_update_notifier: 'false',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      ...extraEnv
    };
  }

  createLogWritable(session, streamName) {
    return new Writable({
      write: (chunk, _encoding, callback) => {
        try {
          const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
          this.appendLog(session, `[${streamName}] ${text}`);
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error('Failed to write command log chunk.'));
        }
      }
    });
  }

  async runCommand(session, command, { allowFailure = false } = {}) {
    if (!session.sandbox) {
      throw new Error('Sandbox is not initialized.');
    }

    this.appendLog(session, `[cmd] ${this.formatCommand(command)}`);

    const result = await session.sandbox.runCommand({
      ...command,
      cwd: command.cwd || WORKSPACE_ROOT,
      env: this.buildSandboxEnv(command.env),
      stdout: this.createLogWritable(session, 'stdout'),
      stderr: this.createLogWritable(session, 'stderr')
    });

    if (!allowFailure && result.exitCode !== 0) {
      const stderr = await result.stderr().catch(() => '');
      throw new Error(`Command failed (${result.exitCode}): ${command.cmd} ${(command.args || []).join(' ')}${stderr ? `\n${stderr.trim()}` : ''}`);
    }

    return result;
  }

  formatCommand(command) {
    const cmd = String(command?.cmd || '').trim();
    const args = Array.isArray(command?.args) ? command.args : [];
    return [cmd, ...args].join(' ').trim();
  }

  async runCommandCapture(session, command) {
    const result = await this.runCommand(session, command, { allowFailure: true });
    const [stdout, stderr] = await Promise.all([
      result.stdout().catch(() => ''),
      result.stderr().catch(() => '')
    ]);

    return {
      exitCode: Number(result.exitCode) || 0,
      stdout: normalizeLF(stdout || ''),
      stderr: normalizeLF(stderr || '')
    };
  }

  createStageError({ stage, command, exitCode, stdout, stderr, message }) {
    const text = typeof message === 'string' && message.trim()
      ? message.trim()
      : `Stage "${stage}" failed${Number.isFinite(exitCode) ? ` (${exitCode})` : ''}.`;
    const error = new Error(text);
    error.stage = String(stage || 'unknown');
    error.command = String(command || '').trim();
    error.exitCode = Number.isFinite(exitCode) ? Number(exitCode) : null;
    error.stdout = normalizeLF(stdout || '');
    error.stderr = normalizeLF(stderr || '');
    return error;
  }

  parsePackageManagerSpec(raw) {
    const text = String(raw || '').trim();
    if (!text) {
      return null;
    }

    const matched = text.match(/^(npm|pnpm|yarn)@(.+)$/i);
    if (!matched) {
      return null;
    }

    return {
      name: matched[1].toLowerCase(),
      spec: `${matched[1].toLowerCase()}@${matched[2]}`
    };
  }

  async readPackageManagerSpec(session) {
    const probe = await this.runCommandCapture(session, {
      cmd: 'node',
      args: [
        '-e',
        [
          "const fs=require('fs');",
          "try{",
          "const raw=fs.readFileSync('package.json','utf8');",
          "const pkg=JSON.parse(raw);",
          "process.stdout.write(String(pkg.packageManager||''));",
          "}catch(_){process.stdout.write('');}"
        ].join('')
      ]
    });

    if (probe.exitCode !== 0) {
      return null;
    }

    return this.parsePackageManagerSpec(probe.stdout);
  }

  async resolvePackageManager(session, forceRefresh = false) {
    if (!forceRefresh && session.packageManager) {
      return {
        name: session.packageManager,
        spec: session.packageManagerSpec || null
      };
    }

    const hasPackageJson = await this.fileExists(session, 'package.json');
    if (!hasPackageJson) {
      session.packageManager = 'npm';
      session.packageManagerSpec = null;
      return { name: 'npm', spec: null };
    }

    const explicit = await this.readPackageManagerSpec(session);

    let name = explicit?.name || null;
    let spec = explicit?.spec || null;

    if (!name) {
      if (await this.fileExists(session, 'pnpm-lock.yaml')) {
        name = 'pnpm';
      } else if (await this.fileExists(session, 'yarn.lock')) {
        name = 'yarn';
      } else {
        name = 'npm';
      }
    }

    session.packageManager = name;
    session.packageManagerSpec = spec;
    this.appendLog(session, `[runtime] package manager: ${name}${spec ? ` (${spec})` : ''}`);

    return { name, spec };
  }

  toPackageManagerCommand(packageManager, args) {
    const safeArgs = Array.isArray(args) ? args : [];
    if (packageManager === 'pnpm') {
      return { cmd: 'corepack', args: ['pnpm', ...safeArgs] };
    }
    if (packageManager === 'yarn') {
      return { cmd: 'corepack', args: ['yarn', ...safeArgs] };
    }
    return { cmd: 'npm', args: safeArgs };
  }

  commandForRunScript(packageManager, scriptName, extraArgs = []) {
    const extras = Array.isArray(extraArgs) ? extraArgs : [];
    if (packageManager === 'pnpm') {
      return this.toPackageManagerCommand('pnpm', ['run', scriptName, ...(extras.length ? ['--', ...extras] : [])]);
    }
    if (packageManager === 'yarn') {
      return this.toPackageManagerCommand('yarn', ['run', scriptName, ...extras]);
    }
    return this.toPackageManagerCommand('npm', ['run', scriptName, ...(extras.length ? ['--', ...extras] : [])]);
  }

  async ensurePackageManagerRuntime(session, packageManagerInfo) {
    const info = packageManagerInfo || { name: 'npm', spec: null };
    if (info.name === 'npm') {
      return;
    }

    if (info.spec) {
      const prepare = await this.runCommandCapture(session, {
        cmd: 'corepack',
        args: ['prepare', info.spec, '--activate']
      });

      if (prepare.exitCode === 0) {
        return;
      }
    }

    const fallback = await this.runCommandCapture(session, {
      cmd: 'corepack',
      args: ['enable']
    });

    if (fallback.exitCode !== 0) {
      throw this.createStageError({
        stage: 'package_manager',
        command: 'corepack enable',
        exitCode: fallback.exitCode,
        stdout: fallback.stdout,
        stderr: fallback.stderr,
        message: 'Failed to prepare package manager runtime.'
      });
    }
  }

  async captureRuntimeFingerprint(session, packageManagerInfo) {
    if (session.runtimeFingerprintCaptured) {
      return;
    }

    const nodeVersionProbe = await this.runCommandCapture(session, { cmd: 'node', args: ['-v'] });
    const pmProbe = await this.runCommandCapture(session, this.toPackageManagerCommand(packageManagerInfo?.name || 'npm', ['-v']));

    const nodeVersion = (nodeVersionProbe.stdout || '').trim() || 'unknown';
    const pmVersion = (pmProbe.stdout || '').trim() || 'unknown';
    this.appendLog(
      session,
      `[runtime] sandbox=${this.runtime} node=${nodeVersion} ${packageManagerInfo?.name || 'npm'}=${pmVersion}`
    );
    session.runtimeFingerprintCaptured = true;
  }

  async bootstrapMissingPackageJson(session) {
    if (!session.sandbox) {
      return false;
    }

    if (await this.fileExists(session, 'package.json')) {
      return false;
    }

    const candidates = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
    const files = [];

    for (const filePath of candidates) {
      try {
        const content = await fs.readFile(filePath);
        files.push({
          path: toSandboxPath(filePath),
          content: Buffer.from(content)
        });
      } catch {
        // ignore missing local scaffold files
      }
    }

    if (!files.some((item) => item.path.endsWith('/package.json'))) {
      return false;
    }

    await session.sandbox.writeFiles(files);
    this.appendLog(
      session,
      `[heal] Bootstrapped workspace files: ${files
        .map((item) => item.path.replace(`${WORKSPACE_ROOT}/`, ''))
        .join(', ')}`
    );
    session.packageManager = null;
    session.packageManagerSpec = null;
    session.skipBuild = false;
    return true;
  }

  async fileExists(session, relativePath) {
    const safePath = String(relativePath || '').replace(/"/g, '\\"');
    const probe = await this.runCommand(
      session,
      {
        cmd: 'bash',
        args: ['-lc', `test -f "${safePath}"`]
      },
      { allowFailure: true }
    );
    return probe.exitCode === 0;
  }

  async anyFileExists(session, paths) {
    for (const filePath of Array.isArray(paths) ? paths : []) {
      if (await this.fileExists(session, filePath)) {
        return true;
      }
    }
    return false;
  }

  async directoryExists(session, relativePath) {
    const safePath = String(relativePath || '').replace(/"/g, '\\"');
    const probe = await this.runCommand(
      session,
      {
        cmd: 'bash',
        args: ['-lc', `test -d "${safePath}"`]
      },
      { allowFailure: true }
    );
    return probe.exitCode === 0;
  }

  async readTextFile(session, relativePath) {
    const safeRelativePath = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!safeRelativePath) {
      return null;
    }

    const readResult = await this.runCommandCapture(session, {
      cmd: 'node',
      args: [
        '-e',
        [
          "const fs=require('fs');",
          `const p=${JSON.stringify(safeRelativePath)};`,
          'try{process.stdout.write(fs.readFileSync(p,\'utf8\'));}',
          'catch(e){if(e&&e.code===\'ENOENT\'){process.exit(2);}throw e;}'
        ].join('')
      ]
    });

    if (readResult.exitCode === 0) {
      return readResult.stdout;
    }

    if (readResult.exitCode === 2) {
      return null;
    }

    throw this.createStageError({
      stage: 'patch',
      command: `read ${safeRelativePath}`,
      exitCode: readResult.exitCode,
      stdout: readResult.stdout,
      stderr: readResult.stderr,
      message: `Failed to read file before patch apply: ${safeRelativePath}`
    });
  }

  async resolveSectionContent(session, section, stagedContentByPath) {
    if (!section || typeof section !== 'object') {
      return '';
    }

    if (section.action === 'updated' && section.diffLike === true && Array.isArray(section.hunks) && section.hunks.length > 0) {
      let baseContent = '';
      if (stagedContentByPath.has(section.path)) {
        baseContent = stagedContentByPath.get(section.path) || '';
      } else {
        baseContent = (await this.readTextFile(session, section.path)) || '';
      }
      return applyUnifiedHunks(baseContent, section.hunks);
    }

    return normalizeTextContent(section.content);
  }

  buildInstallAttempts(packageManager, hasLockFile) {
    if (packageManager === 'pnpm') {
      return hasLockFile
        ? [
            { command: this.toPackageManagerCommand('pnpm', ['install', '--frozen-lockfile']), label: 'pnpm install --frozen-lockfile' },
            { command: this.toPackageManagerCommand('pnpm', ['install', '--no-frozen-lockfile']), label: 'pnpm install fallback' }
          ]
        : [{ command: this.toPackageManagerCommand('pnpm', ['install']), label: 'pnpm install' }];
    }

    if (packageManager === 'yarn') {
      return hasLockFile
        ? [
            { command: this.toPackageManagerCommand('yarn', ['install', '--frozen-lockfile']), label: 'yarn install --frozen-lockfile' },
            { command: this.toPackageManagerCommand('yarn', ['install']), label: 'yarn install fallback' }
          ]
        : [{ command: this.toPackageManagerCommand('yarn', ['install']), label: 'yarn install' }];
    }

    return hasLockFile
      ? [
          { command: this.toPackageManagerCommand('npm', ['ci', '--no-audit', '--no-fund']), label: 'npm ci' },
          { command: this.toPackageManagerCommand('npm', ['install', '--no-audit', '--no-fund']), label: 'npm install' },
          {
            command: this.toPackageManagerCommand('npm', ['install', '--no-audit', '--no-fund', '--legacy-peer-deps']),
            label: 'npm install fallback'
          }
        ]
      : [
          { command: this.toPackageManagerCommand('npm', ['install', '--no-audit', '--no-fund']), label: 'npm install' },
          {
            command: this.toPackageManagerCommand('npm', ['install', '--no-audit', '--no-fund', '--legacy-peer-deps']),
            label: 'npm install fallback'
          }
        ];
  }

  async installDependencies(session, packageManagerInfo) {
    const hasPackageJson = await this.fileExists(session, 'package.json');
    if (!hasPackageJson) {
      throw new Error('Cannot install dependencies: package.json is missing in sandbox workspace.');
    }

    const pm = packageManagerInfo?.name || 'npm';
    const hasLockFile =
      pm === 'pnpm'
        ? await this.fileExists(session, 'pnpm-lock.yaml')
        : pm === 'yarn'
          ? await this.fileExists(session, 'yarn.lock')
          : await this.fileExists(session, 'package-lock.json');
    const installAttempts = this.buildInstallAttempts(pm, hasLockFile);

    let lastError = null;

    for (const attempt of installAttempts) {
      this.appendLog(session, `[deps] ${attempt.label}`);

      const result = await this.runCommandCapture(session, attempt.command);

      if (result.exitCode === 0) {
        this.appendLog(session, `[deps] ${attempt.label} succeeded.`);
        return;
      }

      const stderr = (result.stderr || '').trim();
      const stdout = (result.stdout || '').trim();
      const message = cleanSummaryMessage(stderr || stdout || `${attempt.label} failed.`);
      lastError = this.createStageError({
        stage: 'install',
        command: this.formatCommand(attempt.command),
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        message: `${attempt.label} failed (${result.exitCode}): ${message}`
      });
      this.appendLog(session, `[deps] ${message}`);

      await this.runCommand(
        session,
        {
          cmd: 'bash',
          args: ['-lc', 'rm -rf node_modules']
        },
        { allowFailure: true }
      );
    }

    throw (
      lastError ||
      this.createStageError({
        stage: 'install',
        message: 'Dependency installation failed.'
      })
    );
  }

  async validatePackageJson(session) {
    const probe = await this.runCommand(
      session,
      {
        cmd: 'node',
        args: ['-e', "const fs=require('fs');JSON.parse(fs.readFileSync('package.json','utf8'));"]
      },
      { allowFailure: true }
    );

    return probe.exitCode === 0;
  }

  async sanitizePackageJson(session) {
    await this.runCommand(
      session,
      {
        cmd: 'node',
        args: [
          '-e',
          [
            "const fs=require('fs');",
            "const p='package.json';",
            "let raw=fs.readFileSync(p,'utf8').replace(/\\r\\n/g,'\\n').replace(/\\r/g,'\\n');",
            "raw=raw.split('\\n').filter((line)=>!/^\\s*\\*\\*\\*\\s+/.test(line)).join('\\n');",
            "raw=raw.trim();",
            "if(raw&&!raw.endsWith('\\n'))raw+='\\n';",
            "JSON.parse(raw);",
            "fs.writeFileSync(p,raw,'utf8');"
          ].join('')
        ]
      },
      { allowFailure: false }
    );
  }

  async ensurePackageJsonReady(session) {
    const hasPackageJson = await this.fileExists(session, 'package.json');
    if (!hasPackageJson) {
      return;
    }

    if (await this.validatePackageJson(session)) {
      return;
    }

    this.appendLog(session, '[deps] Detected invalid package.json. Trying automatic cleanup.');

    try {
      await this.sanitizePackageJson(session);
      this.appendLog(session, '[deps] package.json cleanup succeeded.');
    } catch (error) {
      throw new Error(
        `Invalid package.json after patch. Ensure JSON is valid and patch markers are not inside file content. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  streamDetachedLogs(session, command) {
    (async () => {
      try {
        for await (const event of command.logs()) {
          const prefix = event.stream === 'stderr' ? '[stderr]' : '[stdout]';
          this.appendLog(session, `${prefix} ${event.data}`);
        }
      } catch (error) {
        this.appendLog(
          session,
          `[sandbox] log stream closed: ${error instanceof Error ? error.message : 'Unknown log stream error.'}`
        );
      }
    })();
  }

  buildDevServerCandidates(packageManager) {
    return [
      {
        command: this.commandForRunScript(packageManager, 'dev', ['--host', '0.0.0.0', '--port', String(this.port)]),
        label: `${packageManager} run dev`
      },
      {
        command: { cmd: 'npx', args: ['vite', '--host', '0.0.0.0', '--port', String(this.port)] },
        label: 'npx vite'
      },
      {
        command: { cmd: 'npx', args: ['next', 'dev', '-H', '0.0.0.0', '-p', String(this.port)] },
        label: 'npx next dev'
      }
    ];
  }

  async startDevServer(session, packageManagerInfo) {
    if (!session.sandbox) {
      throw new Error('Sandbox is not initialized.');
    }

    if (session.devCommand) {
      try {
        await session.devCommand.kill('SIGTERM');
        this.appendLog(session, '[sandbox] Previous dev server stopped.');
      } catch {
        this.appendLog(session, '[sandbox] Previous dev server was not running.');
      }
      session.devCommand = null;
    }

    const packageManager = packageManagerInfo?.name || 'npm';
    const candidates = this.buildDevServerCandidates(packageManager);

    let lastError = null;

    for (const candidate of candidates) {
      try {
        this.appendLog(session, `[sandbox] Starting dev server: ${this.formatCommand(candidate.command)}`);

        const command = await session.sandbox.runCommand({
          ...candidate.command,
          cwd: WORKSPACE_ROOT,
          env: this.buildSandboxEnv(candidate.command.env),
          detached: true
        });

        session.devCommand = command;
        this.streamDetachedLogs(session, command);

        const quickExit = await Promise.race([
          command.wait().then((result) => ({ done: true, exitCode: result.exitCode })),
          sleep(1500).then(() => ({ done: false, exitCode: null }))
        ]);

        if (quickExit.done) {
          const stderr = await command.stderr().catch(() => '');
          throw this.createStageError({
            stage: 'start_preview',
            command: this.formatCommand(candidate.command),
            exitCode: quickExit.exitCode,
            stderr,
            message: `Dev server exited too early (${quickExit.exitCode ?? 'unknown'}). ${cleanSummaryMessage(stderr)}`
          });
        }

        this.appendLog(session, `[sandbox] Dev server started via ${candidate.label}.`);
        return;
      } catch (error) {
        lastError = error;
        this.appendLog(session, `[sandbox] Dev server start failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (lastError instanceof Error) {
      if (!lastError.stage) {
        lastError.stage = 'start_preview';
      }
      throw lastError;
    }

    throw this.createStageError({
      stage: 'start_preview',
      message: 'Failed to start preview dev server.'
    });
  }

  async waitUntilPreviewReady(session) {
    if (!session.sandbox) {
      throw new Error('Sandbox is not initialized.');
    }

    const probeScript = [
      "const http=require('http');",
      `const req=http.get('http://127.0.0.1:${this.port}',(res)=>{`,
      '  const code=Number(res.statusCode)||0;',
      "  let body='';",
      "  res.setEncoding('utf8');",
      "  res.on('data',(chunk)=>{ if(body.length < 120000) body += chunk; });",
      "  res.on('end',()=>{",
      "    const lower=String(body||'').toLowerCase();",
      "    const hasHtml=lower.includes('<html');",
      "    const hasBody=lower.includes('<body');",
      "    const hasMount=lower.includes('id=\"root\"')||lower.includes(\"id='root'\")||lower.includes('id=\"__next\"')||lower.includes(\"id='__next'\");",
      "    process.stdout.write(JSON.stringify({code,hasHtml,hasBody,hasMount}));",
      "    process.exit(code === 200 && hasHtml && (hasMount || hasBody) ? 0 : 1);",
      "  });",
      '});',
      "req.on('error',(err)=>{process.stdout.write(JSON.stringify({error:String(err&&err.message||err)}));process.exit(2);});",
      "req.setTimeout(2400,()=>{req.destroy(new Error('timeout'));});"
    ].join('');

    let lastProbe = null;

    // Vite/Next cold starts can be slow; keep waiting for an actual healthy response.
    for (let attempt = 1; attempt <= HEALTHCHECK_MAX_ATTEMPTS; attempt += 1) {
      const probe = await this.runCommandCapture(session, {
        cmd: 'node',
        args: ['-e', probeScript]
      });

      let parsed = {};
      try {
        parsed = probe.stdout ? JSON.parse(probe.stdout) : {};
      } catch {
        parsed = {};
      }

      const statusCode = Number(parsed.code);
      const healthy =
        probe.exitCode === 0 &&
        statusCode === 200 &&
        parsed.hasHtml === true &&
        (parsed.hasMount === true || parsed.hasBody === true);
      if (healthy) {
        this.appendLog(session, `[sandbox] Healthcheck passed (attempt ${attempt}, status=${statusCode}).`);
        return;
      }

      lastProbe = {
        attempt,
        exitCode: probe.exitCode,
        statusCode: Number.isFinite(statusCode) ? statusCode : null,
        hasHtml: parsed.hasHtml === true,
        hasBody: parsed.hasBody === true,
        hasMount: parsed.hasMount === true,
        raw: tailLines(`${probe.stderr}\n${probe.stdout}`)
      };

      await sleep(HEALTHCHECK_INTERVAL_MS);
    }

    const runtimeTail = tailLines(session.logs.join('\n'));
    throw this.createStageError({
      stage: 'healthcheck',
      command: `GET http://127.0.0.1:${this.port}`,
      message: `Healthcheck failed. ${
        lastProbe
          ? `lastProbe={attempt:${lastProbe.attempt}, exit:${lastProbe.exitCode}, status:${lastProbe.statusCode}, html:${lastProbe.hasHtml}, body:${lastProbe.hasBody}, mount:${lastProbe.hasMount}}`
          : 'No probe output.'
      }`,
      stderr: tailLines(`${lastProbe?.raw || ''}\n${runtimeTail}`)
    });
  }

  async readProjectMetadata(session) {
    const hasPackageJson = await this.fileExists(session, 'package.json');
    let hasBuildScript = false;
    let dependencies = new Set();

    if (hasPackageJson) {
      const probe = await this.runCommandCapture(session, {
        cmd: 'node',
        args: [
          '-e',
          [
            "const fs=require('fs');",
            "try{",
            "const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));",
            "const hasBuild=!!(pkg&&pkg.scripts&&typeof pkg.scripts.build==='string'&&pkg.scripts.build.trim());",
            "const deps=Object.keys(Object.assign({},pkg.dependencies||{},pkg.devDependencies||{}));",
            "process.stdout.write(JSON.stringify({hasBuild,deps}));",
            "}catch(_){process.stdout.write('{}');process.exit(1);}"
          ].join('')
        ]
      });

      if (probe.exitCode === 0) {
        try {
          const parsed = JSON.parse(probe.stdout || '{}');
          hasBuildScript = parsed.hasBuild === true;
          dependencies = new Set(Array.isArray(parsed.deps) ? parsed.deps.map((x) => String(x || '').trim()).filter(Boolean) : []);
        } catch {
          hasBuildScript = false;
          dependencies = new Set();
        }
      }
    }

    const hasViteConfig = await this.anyFileExists(session, [
      'vite.config.ts',
      'vite.config.js',
      'vite.config.mjs',
      'vite.config.cjs'
    ]);
    const hasNextConfig = await this.anyFileExists(session, ['next.config.js', 'next.config.mjs', 'next.config.ts']);
    const isViteProject = hasViteConfig || dependencies.has('vite');
    const isNextProject = hasNextConfig || dependencies.has('next');

    return {
      hasPackageJson,
      hasBuildScript,
      dependencies,
      hasViteConfig,
      hasNextConfig,
      isViteProject,
      isNextProject
    };
  }

  async resolveBuildPlan(session, packageManagerInfo) {
    if (session.skipBuild) {
      return {
        skip: true,
        reason: 'heal_policy_skip_build',
        candidates: []
      };
    }

    const packageManager = packageManagerInfo?.name || 'npm';
    const meta = await this.readProjectMetadata(session);

    if (meta.hasBuildScript) {
      return {
        skip: false,
        reason: '',
        candidates: [
          {
            command: this.commandForRunScript(packageManager, 'build'),
            label: `${packageManager} run build`
          }
        ]
      };
    }

    if (meta.isViteProject) {
      return {
        skip: false,
        reason: '',
        candidates: [{ command: { cmd: 'npx', args: ['vite', 'build'] }, label: 'npx vite build' }]
      };
    }

    if (meta.isNextProject) {
      return {
        skip: false,
        reason: '',
        candidates: [{ command: { cmd: 'npx', args: ['next', 'build'] }, label: 'npx next build' }]
      };
    }

    return {
      skip: true,
      reason: 'no_build_target',
      candidates: []
    };
  }

  async runBuildProject(session, packageManagerInfo) {
    const plan = await this.resolveBuildPlan(session, packageManagerInfo);
    if (plan.skip) {
      this.appendLog(session, `[build] Skipped (${plan.reason}).`);
      return {
        skipped: true,
        reason: plan.reason
      };
    }

    const candidates = plan.candidates;
    let lastFailure = null;

    for (const candidate of candidates) {
      this.appendLog(session, `[build] ${candidate.label}`);
      const result = await this.runCommandCapture(session, candidate.command);
      if (result.exitCode === 0) {
        this.appendLog(session, `[build] ${candidate.label} succeeded.`);
        return;
      }

      lastFailure = this.createStageError({
        stage: 'build',
        command: this.formatCommand(candidate.command),
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        message: `${candidate.label} failed (${result.exitCode}).`
      });

      this.appendLog(
        session,
        `[build] ${candidate.label} failed (${result.exitCode}): ${cleanSummaryMessage(result.stderr || result.stdout)}`
      );
    }

    throw (
      lastFailure ||
      this.createStageError({
        stage: 'build',
        message: 'Build failed.'
      })
    );
  }

  classifyProblem(errorLike) {
    const stage = typeof errorLike?.stage === 'string' ? errorLike.stage : 'unknown';
    const command = typeof errorLike?.command === 'string' ? errorLike.command : '';
    const exitCode = Number.isFinite(errorLike?.exitCode) ? Number(errorLike.exitCode) : null;
    const stderr = normalizeLF(errorLike?.stderr || '');
    const stdout = normalizeLF(errorLike?.stdout || '');
    const rawTail = tailLines(`${stderr}\n${stdout}\n${errorLike?.message || ''}`);
    const lineSource = rawTail || String(errorLike?.message || '');

    let kind = 'unknown';
    let file = null;
    let line = null;
    let module = null;

    const missingModuleMatch =
      lineSource.match(/Cannot find module ['"]([^'"]+)['"]/i) ||
      lineSource.match(/Failed to resolve import ["']([^"']+)["']/i) ||
      lineSource.match(/Module not found.*['"]([^'"]+)['"]/i);
    if (missingModuleMatch) {
      kind = 'missing_dependency';
      module = missingModuleMatch[1];
    } else if (
      /ENOENT/i.test(lineSource) &&
      /index\.html/i.test(lineSource) &&
      /(no such file or directory|stat|open)/i.test(lineSource)
    ) {
      kind = 'missing_index_html';
    } else if (/cannot install dependencies:\s*package\.json is missing|package\.json is missing in sandbox workspace/i.test(lineSource)) {
      kind = 'missing_package_json';
    } else if (/EADDRINUSE|address already in use|port \d+ is already in use/i.test(lineSource)) {
      kind = 'port_in_use';
    } else if (/missing script:\s*build/i.test(lineSource)) {
      kind = 'missing_build_script';
    } else if (/could not resolve entry module ['"]?index\.html['"]?/i.test(lineSource)) {
      kind = 'build_entry_missing';
    } else if (/missing script:\s*([^\n\r]+)/i.test(lineSource)) {
      kind = 'missing_script';
    } else if (/TS\d{4}/.test(lineSource)) {
      kind = 'typescript_error';
      const tsMatch = lineSource.match(/([A-Za-z0-9_./-]+\.[a-z]+)\((\d+),\d+\)/i);
      if (tsMatch) {
        file = tsMatch[1];
        line = Number.parseInt(tsMatch[2], 10) || null;
      }
    } else if (/Unexpected token|SyntaxError/i.test(lineSource)) {
      kind = 'syntax_error';
      const locMatch = lineSource.match(/([A-Za-z0-9_./-]+\.[a-z]+):(\d+):\d+/i);
      if (locMatch) {
        file = locMatch[1];
        line = Number.parseInt(locMatch[2], 10) || null;
      }
    } else if (/package\.json/i.test(lineSource) && /JSON|Unexpected token|invalid/i.test(lineSource)) {
      kind = 'invalid_package_json';
      file = 'package.json';
    } else if (/ENOENT/i.test(lineSource) && /\/home\/sbx_user/i.test(lineSource)) {
      kind = 'sandbox_home_missing';
    } else if (stage === 'healthcheck') {
      kind = 'healthcheck_failed';
    } else if (stage === 'build') {
      kind = 'build_failed';
    } else if (stage === 'install') {
      kind = 'install_failed';
    } else if (stage === 'start_preview') {
      kind = 'preview_start_failed';
    }

    const summaryByKind = {
      missing_dependency: `Missing dependency${module ? ` "${module}"` : ''}`,
      missing_index_html: 'index.html is missing for server route',
      missing_package_json: 'package.json is missing',
      missing_build_script: 'Build script is missing',
      build_entry_missing: 'Build entry point is missing',
      port_in_use: `Port ${this.port} is already in use`,
      missing_script: 'Missing npm script',
      typescript_error: `TypeScript error${file ? ` in ${file}` : ''}`,
      syntax_error: `Syntax error${file ? ` in ${file}` : ''}`,
      invalid_package_json: 'Invalid package.json',
      sandbox_home_missing: 'Sandbox HOME/cache directory issue',
      healthcheck_failed: 'Preview healthcheck failed',
      build_failed: 'Build failed',
      install_failed: 'Dependency installation failed',
      preview_start_failed: 'Preview server failed to start',
      unknown: cleanSummaryMessage(errorLike?.message || 'Validation failed')
    };

    return {
      kind,
      stage,
      command,
      exitCode,
      file,
      line,
      module,
      message: summaryByKind[kind] || summaryByKind.unknown,
      rawTail
    };
  }

  errorSignature(problem) {
    const core = [problem?.kind || 'unknown', problem?.stage || 'unknown', problem?.file || '', problem?.line || '', problem?.module || ''];
    return core.join('|');
  }

  diagnoseLabel(problem) {
    if (problem?.stage === 'build') return 'Diagnose build error';
    if (problem?.stage === 'install') return 'Diagnose install error';
    if (problem?.stage === 'healthcheck' || problem?.stage === 'start_preview') return 'Diagnose preview error';
    return 'Diagnose error';
  }

  async diagnoseProblem(session, problem) {
    await this.runOperation(
      session,
      {
        kind: 'diagnose',
        label: this.diagnoseLabel(problem)
      },
      async () => {
        this.appendLog(
          session,
          `[diagnose] kind=${problem.kind} stage=${problem.stage} message=${problem.message} command="${problem.command || ''}"`
        );
        if (problem.rawTail) {
          this.appendLog(session, `[diagnose.tail]\n${problem.rawTail}`);
        }
      }
    );
  }

  async stopProcessOnPreviewPort(session) {
    await this.runCommand(
      session,
      {
        cmd: 'bash',
        args: [
          '-lc',
          [
            `if command -v lsof >/dev/null 2>&1; then`,
            `  pids=$(lsof -ti tcp:${this.port} || true);`,
            `  if [ -n "$pids" ]; then kill -9 $pids || true; fi;`,
            `elif command -v fuser >/dev/null 2>&1; then`,
            `  fuser -k ${this.port}/tcp || true;`,
            'fi'
          ].join(' ')
        ]
      },
      { allowFailure: true }
    );
  }

  async autoFixMissingIndexHtml(session) {
    let hasPublicIndex = await this.fileExists(session, 'public/index.html');
    let hasRootIndex = await this.fileExists(session, 'index.html');
    let changed = false;

    if (!hasRootIndex) {
      if (hasPublicIndex) {
        await this.runCommand(
          session,
          {
            cmd: 'bash',
            args: ['-lc', 'cp public/index.html index.html']
          },
          { allowFailure: false }
        );
        this.appendLog(session, '[heal] Created root index.html from public/index.html.');
        changed = true;
        hasRootIndex = true;
      } else {
        await this.runCommand(
          session,
          {
            cmd: 'bash',
            args: [
              '-lc',
              [
                "cat > index.html <<'EOF'",
                '<!doctype html>',
                '<html>',
                '  <head><meta charset=\"UTF-8\" /><meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" /><title>Preview</title></head>',
                '  <body><div id=\"root\"></div></body>',
                '</html>',
                'EOF'
              ].join('\n')
            ]
          },
          { allowFailure: false }
        );
        this.appendLog(session, '[heal] Created fallback root index.html.');
        changed = true;
        hasRootIndex = true;
      }
    }

    if (!hasPublicIndex && hasRootIndex) {
      await this.runCommand(
        session,
        {
          cmd: 'bash',
          args: ['-lc', 'mkdir -p public && cp index.html public/index.html']
        },
        { allowFailure: true }
      );
      this.appendLog(session, '[heal] Mirrored root index.html to public/index.html.');
      changed = true;
      hasPublicIndex = true;
    }

    const hasServerJs = await this.fileExists(session, 'server.js');
    if (hasServerJs) {
      const patchRoute = await this.runCommandCapture(session, {
        cmd: 'node',
        args: [
          '-e',
          [
            "const fs=require('fs');",
            "const p='server.js';",
            "let src=fs.readFileSync(p,'utf8');",
            "const before=src;",
            "src=src.replace(/path\\.join\\(\\s*__dirname\\s*,\\s*['\\\"]index\\.html['\\\"]\\s*\\)/g,\"path.join(__dirname, 'public', 'index.html')\");",
            "src=src.replace(/path\\.join\\(\\s*process\\.cwd\\(\\)\\s*,\\s*['\\\"]index\\.html['\\\"]\\s*\\)/g,\"path.join(process.cwd(), 'public', 'index.html')\");",
            "src=src.replace(/path\\.resolve\\(\\s*['\\\"]\\/var\\/task['\\\"]\\s*,\\s*['\\\"]index\\.html['\\\"]\\s*\\)/g,\"process.cwd() + '/public/index.html'\");",
            "src=src.replace(/path\\.join\\(\\s*['\\\"]\\/var\\/task['\\\"]\\s*,\\s*['\\\"]index\\.html['\\\"]\\s*\\)/g,\"process.cwd() + '/public/index.html'\");",
            "src=src.replace(/['\\\"]\\/var\\/task\\/index\\.html['\\\"]/g,\"process.cwd() + '/public/index.html'\");",
            "if(src!==before){fs.writeFileSync(p,src,'utf8');process.stdout.write('patched');}else{process.stdout.write('unchanged');}"
          ].join('')
        ]
      });

      if (patchRoute.exitCode === 0 && String(patchRoute.stdout || '').includes('patched')) {
        this.appendLog(session, '[heal] Patched server.js index.html route to public/index.html.');
        changed = true;
      }
    }

    // Compatibility fallback for runtimes that resolve static root as /var/task.
    await this.runCommand(
      session,
      {
        cmd: 'bash',
        args: ['-lc', "if [ -f index.html ]; then mkdir -p /var/task 2>/dev/null || true; cp index.html /var/task/index.html 2>/dev/null || true; fi"]
      },
      { allowFailure: true }
    );

    return changed;
  }

  async applyAutoFix(session, problem) {
    switch (problem.kind) {
      case 'sandbox_home_missing': {
        await session.sandbox.mkDir(SANDBOX_HOME).catch(() => {});
        await session.sandbox.mkDir(SANDBOX_NPM_CACHE).catch(() => {});
        await this.runCommand(
          session,
          {
            cmd: 'bash',
            args: ['-lc', `mkdir -p "${SANDBOX_HOME}" "${SANDBOX_NPM_CACHE}"`]
          },
          { allowFailure: true }
        );
        session.dependenciesInstalled = false;
        return true;
      }

      case 'invalid_package_json': {
        await this.ensurePackageJsonReady(session);
        session.dependenciesInstalled = false;
        return true;
      }

      case 'missing_dependency':
      case 'install_failed': {
        await this.runCommand(
          session,
          {
            cmd: 'bash',
            args: ['-lc', 'rm -rf node_modules']
          },
          { allowFailure: true }
        );
        session.dependenciesInstalled = false;
        return true;
      }

      case 'missing_package_json': {
        const bootstrapped = await this.bootstrapMissingPackageJson(session);
        if (!bootstrapped) {
          return false;
        }
        session.dependenciesInstalled = false;
        return true;
      }

      case 'missing_index_html': {
        const fixed = await this.autoFixMissingIndexHtml(session);
        if (!fixed) {
          return false;
        }
        return true;
      }

      case 'missing_build_script':
      case 'build_entry_missing': {
        session.skipBuild = true;
        this.appendLog(session, '[heal] Build step disabled for current session.');
        return true;
      }

      case 'typescript_error': {
        if (problem.stage === 'build') {
          session.skipBuild = true;
          this.appendLog(session, '[heal] TypeScript build checks failed; switched to runtime-only validation (build skipped).');
          return true;
        }
        return false;
      }

      case 'build_failed': {
        if (/vite\s+build/i.test(problem.command || '')) {
          const meta = await this.readProjectMetadata(session);
          if (!meta.hasBuildScript && !meta.isViteProject && !meta.isNextProject) {
            session.skipBuild = true;
            this.appendLog(session, '[heal] Switched to runtime-only validation (build skipped).');
            return true;
          }
        }
        return false;
      }

      case 'port_in_use': {
        if (session.devCommand) {
          await session.devCommand.kill('SIGTERM').catch(() => {});
          session.devCommand = null;
        }
        await this.stopProcessOnPreviewPort(session);
        return true;
      }

      case 'healthcheck_failed':
      case 'preview_start_failed': {
        if (session.devCommand) {
          await session.devCommand.kill('SIGTERM').catch(() => {});
          session.devCommand = null;
        }
        await this.stopProcessOnPreviewPort(session);
        return true;
      }

      default:
        return false;
    }
  }

  async validatePass(session, { packageManagerInfo, shouldInstall, attempt }) {
    if (shouldInstall) {
      await this.runOperation(
        session,
        {
          kind: 'install',
          label: attempt === 1 ? 'Installing packages' : 'Reinstalling packages'
        },
        async () => {
          await this.installDependencies(session, packageManagerInfo);
        }
      );
      session.dependenciesInstalled = true;
      this.appendLog(session, '[validate] Dependencies installed.');
    }

    await this.runOperation(
      session,
      {
        kind: 'build',
        label: attempt === 1 ? 'Build project' : 'Rebuild'
      },
      async () => {
        await this.runBuildProject(session, packageManagerInfo);
      }
    );

    await this.runOperation(
      session,
      {
        kind: 'server',
        label: 'Start preview'
      },
      async () => {
        await this.startDevServer(session, packageManagerInfo);
      }
    );

    await this.runOperation(
      session,
      {
        kind: 'healthcheck',
        label: 'Healthcheck'
      },
      async () => {
        await this.waitUntilPreviewReady(session);
      }
    );
  }

  async validateWithSelfHeal(session, { changedFiles, shouldInstall }) {
    const lockFiles = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);
    let installRequired =
      shouldInstall || !session.dependenciesInstalled || changedFiles.some((file) => lockFiles.has(file));
    let packageManagerInfo = await this.resolvePackageManager(session, changedFiles.some((file) => lockFiles.has(file)));
    await this.ensurePackageManagerRuntime(session, packageManagerInfo);
    await this.captureRuntimeFingerprint(session, packageManagerInfo);

    let previousSignature = '';
    let repeatCount = 0;
    let lastProblem = null;

    for (let attempt = 1; attempt <= this.maxValidateAttempts; attempt += 1) {
      try {
        await this.validatePass(session, {
          packageManagerInfo,
          shouldInstall: installRequired,
          attempt
        });
        this.appendLog(session, `[validate] Success after ${attempt} attempt(s).`);
        return;
      } catch (error) {
        const problem = this.classifyProblem(error instanceof Error ? error : new Error(String(error)));
        lastProblem = problem;
        await this.diagnoseProblem(session, problem);

        const signature = this.errorSignature(problem);
        if (signature === previousSignature) {
          repeatCount += 1;
        } else {
          repeatCount = 1;
          previousSignature = signature;
        }

        if (attempt >= this.maxValidateAttempts || repeatCount >= 2) {
          throw this.createStageError({
            stage: problem.stage || 'validate',
            command: problem.command || '',
            exitCode: problem.exitCode,
            stderr: problem.rawTail,
            message: `Validation failed after ${attempt} attempt(s): ${problem.message}`
          });
        }

        let fixed = false;
        await this.runOperation(
          session,
          {
            kind: 'heal',
            label: 'Apply fix'
          },
          async () => {
            fixed = await this.applyAutoFix(session, problem);
            if (!fixed) {
              throw this.createStageError({
                stage: 'heal',
                message: `No automatic fix for "${problem.kind}" (${problem.stage}).`
              });
            }
          }
        );

        installRequired = true;
        packageManagerInfo = await this.resolvePackageManager(session, true);
        await this.ensurePackageManagerRuntime(session, packageManagerInfo);
        session.runtimeFingerprintCaptured = false;
        await this.captureRuntimeFingerprint(session, packageManagerInfo);
      }
    }

    throw this.createStageError({
      stage: 'validate',
      message: `Validation failed.${lastProblem ? ` Last issue: ${lastProblem.message}` : ''}`
    });
  }

  async syncPatchInternal(session, patchText) {
    const sections = parsePatchSections(patchText);
    if (!sections.length) {
      throw new Error('Patch has no editable sections (Add/Update/Create File).');
    }

    this.updateCanvasSnapshot(session, sections);

    await this.runOperation(
      session,
      {
        kind: 'sandbox',
        label: session.sandbox ? 'Reusing sandbox' : 'Creating sandbox'
      },
      async () => {
        await this.ensureSandbox(session);
      }
    );

    this.setStatus(session, 'syncing');
    this.appendLog(session, `[sync] Applying ${sections.length} file(s).`);

    const resolvedContentByPath = new Map();
    for (const section of sections) {
      const resolvedContent = await this.resolveSectionContent(session, section, resolvedContentByPath);
      resolvedContentByPath.set(section.path, resolvedContent);
    }

    const filesToWrite = Array.from(resolvedContentByPath.entries()).map(([filePath, content]) => ({
      path: toSandboxPath(filePath),
      content: Buffer.from(content, 'utf8')
    }));

    this.updateCanvasSnapshot(
      session,
      Array.from(resolvedContentByPath.entries()).map(([filePath, content]) => ({
        path: filePath,
        content
      }))
    );

    await this.runOperation(
      session,
      {
        kind: 'patch',
        label: `Applying patch (${sections.length} file${sections.length > 1 ? 's' : ''})`
      },
      async () => {
        const fileOperationIds = sections.map((section) =>
          this.startOperation(session, {
            kind: 'file',
            label: section.action === 'updated' ? `Edit ${section.path}` : `Create ${section.path}`,
            filePath: section.path
          })
        );

        try {
          await session.sandbox.writeFiles(filesToWrite);
          for (const id of fileOperationIds) {
            this.completeOperation(session, id);
          }
        } catch (error) {
          for (const id of fileOperationIds) {
            this.failOperation(session, id, error instanceof Error ? error.message : String(error));
          }
          throw error;
        }
      }
    );

    const changedFiles = Array.from(resolvedContentByPath.keys());
    this.appendLog(session, `[sync] Written: ${changedFiles.join(', ')}`);

    if (changedFiles.includes('package.json')) {
      await this.ensurePackageJsonReady(session);
    }

    const lockFiles = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);
    const hasNodeModules = await this.directoryExists(session, 'node_modules');
    const shouldInstall =
      !session.dependenciesInstalled || !hasNodeModules || changedFiles.some((file) => lockFiles.has(file));
    if (changedFiles.some((file) => lockFiles.has(file))) {
      session.packageManager = null;
      session.packageManagerSpec = null;
      session.skipBuild = false;
    }

    await this.validateWithSelfHeal(session, { changedFiles, shouldInstall });

    const readyOperation = this.startOperation(session, {
      kind: 'preview',
      label: 'Preview ready'
    });
    this.completeOperation(session, readyOperation);

    this.setStatus(session, 'running');
    this.appendLog(session, `[sync] Preview URL: ${session.url}`);

    return this.toPublicState(session, { changedFiles });
  }

  async syncPatch({ sessionId, patch }) {
    const session = this.getOrCreateSession(sessionId);

    session.queue = session.queue
      .catch(() => {})
      .then(() => this.syncPatchInternal(session, patch))
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Unknown preview sync error.';
        this.setStatus(session, 'error', message);
        const opId = this.startOperation(session, {
          kind: 'error',
          label: 'Preview failed'
        });
        this.failOperation(session, opId, message);
        this.appendLog(session, `[error] ${message}`);
        return this.toPublicState(session);
      });

    return session.queue;
  }

  async getState(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') {
      return createEmptyState('');
    }

    const session = this.sessions.get(sessionId.trim());
    if (!session) {
      return createEmptyState(sessionId.trim());
    }

    session.lastTouchedAt = Date.now();
    return this.toPublicState(session);
  }

  async cleanupIdleSessions() {
    const now = Date.now();
    const candidates = [];

    for (const session of this.sessions.values()) {
      if (now - session.lastTouchedAt > this.idleTtlMs) {
        candidates.push(session);
      }
    }

    for (const session of candidates) {
      try {
        if (session.devCommand) {
          await session.devCommand.kill('SIGTERM').catch(() => {});
          session.devCommand = null;
        }

        if (session.sandbox) {
          this.appendLog(session, '[sandbox] Stopping idle sandbox...');
          await session.sandbox.stop({ blocking: true }).catch(() => {});
        }
      } finally {
        this.sessions.delete(session.sessionId);
      }
    }
  }
}
