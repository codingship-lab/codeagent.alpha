const form = document.getElementById('chat-form');
const input = document.getElementById('chat-input');
const sendButton = document.getElementById('send-button');
const messagesEl = document.getElementById('messages');

const chatPanel = document.getElementById('chat-panel');
const previewPanel = document.getElementById('preview-panel');
const tabChat = document.getElementById('tab-chat');
const tabPreview = document.getElementById('tab-preview');

const previewFrame = document.getElementById('preview-frame');
const previewEmpty = document.getElementById('preview-empty');
const previewStatus = document.getElementById('preview-status');
const previewLink = document.getElementById('preview-link');

const appShell = document.querySelector('.app-shell');

const STEP_EVENT_TYPES = new Set(['step.started', 'step.progress', 'step.completed', 'step.error']);
const RUN_EVENT_TYPES = new Set(['run.started', 'run.completed', 'run.error']);

const PREVIEW_STATE_POLL_MS = 1800;
const PREVIEW_SESSION_STORAGE_KEY = 'codeagent.preview.sessionId';

let activeTab = 'chat';
let previewPollTimer = null;
let isSending = false;

const actionRowsById = new Map();
const previewOperationStates = new Map();
const runtimeSteps = new Map();

const runtimeRunState = {
  runId: '',
  runStatus: 'idle',
  finalMessage: '',
  patch: '',
  patchFiles: []
};

const previewState = {
  sessionId: '',
  status: 'idle',
  url: '',
  sandboxId: '',
  operations: [],
  error: null,
  updatedAt: ''
};

const conversation = [
  {
    role: 'assistant',
    content: 'Привет! Я CodeAgent. Чем помочь?'
  }
];

function getOrCreatePreviewSessionId() {
  try {
    const existing = localStorage.getItem(PREVIEW_SESSION_STORAGE_KEY);
    if (existing && existing.trim()) {
      return existing.trim();
    }

    const generated =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

    localStorage.setItem(PREVIEW_SESSION_STORAGE_KEY, generated);
    return generated;
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function normalizeTextContent(raw) {
  let text = typeof raw === 'string' ? raw : '';
  if (!text) return '';

  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  if (text.includes('\\n')) {
    for (let i = 0; i < 8; i += 1) {
      const next = text
        .replace(/\\\\r\\\\n/g, '\n')
        .replace(/\\r\\n/g, '\n')
        .replace(/\\\\n/g, '\n')
        .replace(/\\n/g, '\n')
        .replace(/\\\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\\\\\/g, '\\');
      if (next === text) break;
      text = next;
    }
  }

  const lines = text.split('\n');
  const trailingSlashCount = lines.filter((line) => /\\\s*$/.test(line)).length;
  if (lines.length && trailingSlashCount / lines.length >= 0.25) {
    text = lines.map((line) => line.replace(/\\\s*$/, '')).join('\n');
  }

  return text;
}

function normalizePath(value) {
  return normalizeTextContent(String(value || ''))
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .trim();
}

function normalizePatchText(value) {
  return normalizeTextContent(value || '').trim();
}

function normalizePreviewUrl(value) {
  const raw = normalizeTextContent(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw.replace(/^\/+/, '')}`;
}

function autoResize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 108)}px`;
}

function syncViewportHeight() {
  if (!window.visualViewport || !appShell) return;
  appShell.style.height = `${window.visualViewport.height}px`;
}

function appendTextMessage(role, content) {
  const text = normalizeTextContent(content || '');
  if (!text) return;

  const el = document.createElement('article');
  el.className = `message ${role}`;
  el.textContent = text;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function normalizeActionState(state) {
  if (state === 'completed' || state === 'error') return state;
  return 'running';
}

function iconKind(kind) {
  const value = String(kind || '').toLowerCase();
  if (value === 'thought') return 'thought';
  if (value === 'read') return 'read';
  if (value === 'edit') return 'edit';
  if (value === 'install') return 'install';
  if (value === 'build') return 'build';
  if (value === 'server') return 'server';
  if (value === 'preview') return 'preview';
  if (value === 'error') return 'error';
  if (value === 'diagnose') return 'thought';
  if (value === 'heal') return 'edit';
  if (value === 'plan') return 'thought';
  return 'action';
}

function spinnerSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle class="spinner-track" cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" opacity="0.24"/><path class="spinner-head" d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
}

function iconSvg(kind, state) {
  if (state === 'running') {
    return spinnerSvg();
  }

  if (state === 'completed') {
    return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.9"/><path d="m8 12.3 2.5 2.5L16 9.3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  if (state === 'error') {
    return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.9"/><path d="m9 9 6 6M15 9l-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  }

  if (kind === 'thought') {
    return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 10.2c0-2.8 2.3-5.1 5.1-5.1S17.2 7.4 17.2 10.2c0 1.7-.8 2.9-1.8 3.8-.8.7-1.3 1.3-1.3 2.2H10c0-.9-.5-1.5-1.3-2.2-1-.9-1.7-2.1-1.7-3.8Z" stroke="currentColor" stroke-width="1.8"/><path d="M10 18h4M10.7 20h2.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  }

  if (kind === 'read') {
    return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 12s3-5 9-5 9 5 9 5-3 5-9 5-9-5-9-5Z" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2.6" stroke="currentColor" stroke-width="1.8"/></svg>';
  }

  if (kind === 'edit') {
    return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m4 20 4.2-.9 9-9a1.9 1.9 0 0 0 0-2.7l-.6-.6a1.9 1.9 0 0 0-2.7 0l-9 9L4 20Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m12.8 7.9 3.3 3.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  }

  if (kind === 'install') {
    return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5v-7Z" stroke="currentColor" stroke-width="1.8"/><path d="m8.8 11.1 2 2 4.5-4.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  if (kind === 'build' || kind === 'server') {
    return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2.4" stroke="currentColor" stroke-width="1.8"/><path d="m8 10.4 2 1.8-2 1.8M12.5 14h3.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  if (kind === 'preview') {
    return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="currentColor" stroke-width="1.8"/><path d="M7.2 15.5h9.6M9.2 8.8h5.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  }

  if (kind === 'error') {
    return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3.7 21 19.4H3L12 3.7Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 9v5M12 17h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  }

  return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.8"/></svg>';
}

function createActionRow(id) {
  const row = document.createElement('article');
  row.className = 'message assistant action-message action-message-running';
  row.dataset.actionId = id;

  const icon = document.createElement('span');
  icon.className = 'action-message-icon';

  const content = document.createElement('div');
  content.className = 'action-message-content';

  const title = document.createElement('div');
  title.className = 'action-message-title';

  const meta = document.createElement('div');
  meta.className = 'action-message-meta';

  content.appendChild(title);
  content.appendChild(meta);
  row.appendChild(icon);
  row.appendChild(content);

  messagesEl.appendChild(row);
  actionRowsById.set(id, row);
  return row;
}

const ACTION_TECH_PREFIX_RE =
  /^(Thought(?: for \d+s)?|Read\b|Edit\b|Create\b|Installing\b|Reinstalling\b|Build\b|Rebuild\b|Start\b|Starting\b|Healthcheck\b|Preview\b|Diagnose\b|Apply fix\b|Runtime error\b|Deliver\b|Syncing\b|Working\b|Project structure scanned\b|Implementation started\b|Entered plan mode\b)/i;

function shouldRenderNarrativeAction(title, kind) {
  const text = normalizeTextContent(title || '');
  if (!text) return false;
  if (kind === 'error') return false;
  if (ACTION_TECH_PREFIX_RE.test(text)) return false;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return wordCount >= 2;
}

function upsertActionMessage({ id, kind, title, state, meta = '' }) {
  if (!id) return;

  const resolvedState = normalizeActionState(state);
  const resolvedKind = iconKind(kind);
  const resolvedTitle = normalizeTextContent(title || 'Working');
  const resolvedMeta = normalizeTextContent(meta || (resolvedState === 'running' ? 'in progress' : ''));
  const narrative = shouldRenderNarrativeAction(resolvedTitle, resolvedKind);
  const visibleMeta = narrative && resolvedState !== 'error' ? '' : resolvedMeta;

  let row = actionRowsById.get(id);
  if (!row) {
    row = createActionRow(id);
  }

  row.className = `message assistant action-message action-message-${resolvedState}${narrative ? ' action-message-narrative' : ''}`;
  row.dataset.actionState = resolvedState;
  row.dataset.actionKind = resolvedKind;
  row.dataset.actionNarrative = narrative ? 'true' : 'false';

  const icon = row.querySelector('.action-message-icon');
  const titleEl = row.querySelector('.action-message-title');
  const metaEl = row.querySelector('.action-message-meta');

  if (icon) {
    icon.className = `action-message-icon action-icon-${resolvedKind}`;
    icon.innerHTML = iconSvg(resolvedKind, resolvedState);
  }

  if (titleEl) {
    titleEl.textContent = resolvedTitle;
  }

  if (metaEl) {
    if (visibleMeta) {
      metaEl.textContent = visibleMeta;
      metaEl.hidden = false;
    } else {
      metaEl.textContent = '';
      metaEl.hidden = true;
    }
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function formatPhaseMeta(display, fallback = '') {
  const group = normalizeTextContent(display?.groupTitle || '');
  if (group) return group;
  return normalizeTextContent(fallback || '');
}

function fallbackActionKind(stepType, eventType) {
  if (eventType === 'step.error' || stepType === 'runtime') return 'error';
  if (stepType === 'llm') return 'thought';
  if (stepType === 'read_file') return 'read';
  if (stepType === 'apply_patch') return 'edit';
  if (stepType === 'build') return 'build';
  if (stepType === 'finish') return 'preview';
  return 'action';
}

function fallbackActionTitle(stepType, payload) {
  const path = normalizePath(payload?.path || '');
  if (stepType === 'llm') return 'Thought';
  if (stepType === 'read_file') return path ? `Read ${path}` : 'Read file';
  if (stepType === 'apply_patch') {
    const files = Array.isArray(payload?.files) ? payload.files : [];
    const filePath = normalizePath(files[0]?.path || '');
    if (filePath && files.length <= 1) return `Edit ${filePath}`;
    const count = Number.isFinite(payload?.fileCount) ? payload.fileCount : files.length;
    return `Edit ${Math.max(1, count)} file${Math.max(1, count) > 1 ? 's' : ''}`;
  }
  if (stepType === 'build') return 'Build project';
  if (stepType === 'finish') return 'Deliver result';
  if (stepType === 'runtime') return 'Runtime error';
  return 'Action';
}

function ensureStepSnapshot(stepId, stepType) {
  if (!runtimeSteps.has(stepId)) {
    runtimeSteps.set(stepId, {
      stepId,
      stepType: stepType || 'step',
      startedAtMs: 0,
      completedAtMs: 0,
      status: 'pending'
    });
  }
  return runtimeSteps.get(stepId);
}

function parseEventTimestampMs(value) {
  const ts = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ts) ? ts : Date.now();
}

function thoughtTitleForStep(step, payload) {
  const startedAt = Number.isFinite(step.startedAtMs) ? step.startedAtMs : Date.now();
  const completedAt = Number.isFinite(step.completedAtMs) ? step.completedAtMs : Date.now();
  const sec = Math.max(1, Math.round((completedAt - startedAt) / 1000));

  const explicit = normalizeTextContent(payload?.display?.title || '');
  if (explicit && explicit.toLowerCase() !== 'thought') {
    return explicit;
  }

  return `Thought for ${sec}s`;
}

function toActionFromStepEvent(event, step) {
  const stepType = String(event?.stepType || step?.stepType || 'step');
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  const display = payload.display && typeof payload.display === 'object' ? payload.display : {};

  const eventType = String(event?.type || '');
  const isError = eventType === 'step.error';
  const state = isError ? 'error' : eventType === 'step.completed' ? 'completed' : 'running';
  const id = `runtime:${String(event?.stepId || '')}`;

  let kind = iconKind(display.kind || fallbackActionKind(stepType, eventType));
  let title = normalizeTextContent(display.title || fallbackActionTitle(stepType, payload));

  if (stepType === 'llm' && eventType === 'step.completed') {
    kind = 'thought';
    title = thoughtTitleForStep(step, payload);
  }

  const detailMessage = normalizeTextContent(
    display.details || payload.message || (isError ? 'Step failed' : '')
  );

  const meta = detailMessage;

  return { id, kind, title, state, meta };
}

function resetRuntimeRun() {
  runtimeSteps.clear();
  runtimeRunState.runId = '';
  runtimeRunState.runStatus = 'idle';
  runtimeRunState.finalMessage = '';
  runtimeRunState.patch = '';
  runtimeRunState.patchFiles = [];
}

function applyRuntimeEvent(event) {
  if (!event || typeof event !== 'object') return;

  const eventType = String(event.type || '');
  if (RUN_EVENT_TYPES.has(eventType)) {
    if (typeof event.runId === 'string' && event.runId) {
      runtimeRunState.runId = event.runId;
    }
    if (eventType === 'run.started') runtimeRunState.runStatus = 'running';
    if (eventType === 'run.completed') runtimeRunState.runStatus = 'completed';
    if (eventType === 'run.error') runtimeRunState.runStatus = 'error';
    if (eventType === 'run.error') {
      const message = normalizeTextContent(event?.payload?.message || 'Runtime error');
      upsertActionMessage({
        id: `runtime:run-error:${Date.now()}`,
        kind: 'error',
        title: 'Runtime error',
        state: 'error',
        meta: message
      });
    }
    return;
  }

  if (!STEP_EVENT_TYPES.has(eventType)) return;

  const stepId = String(event.stepId || '');
  if (!stepId) return;

  const stepType = String(event.stepType || 'step');
  const step = ensureStepSnapshot(stepId, stepType);
  step.stepType = stepType;

  if (eventType === 'step.started') {
    step.startedAtMs = parseEventTimestampMs(event.timestamp);
    step.status = 'running';

    if (stepType !== 'llm' && stepType !== 'finish') {
      const action = toActionFromStepEvent(event, step);
      upsertActionMessage(action);
    }
    return;
  }

  if (eventType === 'step.progress') {
    if (step.status === 'pending') {
      step.status = 'running';
    }
    return;
  }

  if (eventType === 'step.completed') {
    step.status = 'completed';
    step.completedAtMs = parseEventTimestampMs(event.timestamp);

    const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};

    if (stepType === 'finish') {
      runtimeRunState.finalMessage = normalizeTextContent(payload.message || runtimeRunState.finalMessage || '');
      runtimeRunState.patch = normalizePatchText(payload.patch || '');
      runtimeRunState.patchFiles = Array.isArray(payload.files) ? payload.files : [];
      return;
    }

    const action = toActionFromStepEvent(event, step);
    upsertActionMessage(action);
    return;
  }

  if (eventType === 'step.error') {
    step.status = 'error';
    step.completedAtMs = parseEventTimestampMs(event.timestamp);
    const action = toActionFromStepEvent(event, step);
    upsertActionMessage(action);
  }
}

function parseSsePacket(packet) {
  const lines = packet.split('\n');
  let eventName = 'message';
  const dataLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (!dataLines.length) return null;

  const payloadText = dataLines.join('\n').trim();
  if (!payloadText) return null;

  try {
    return { eventName, payload: JSON.parse(payloadText) };
  } catch {
    return null;
  }
}

async function readArenaStream(messagesPayload) {
  resetRuntimeRun();

  const response = await fetch('/api/arena/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ messages: messagesPayload })
  });

  if (!response.ok) {
    let text = '';
    try {
      text = await response.text();
    } catch {
      text = '';
    }
    throw new Error(text || 'Arena stream request failed.');
  }

  if (!response.body) {
    throw new Error('Stream body is not available.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let splitAt;
    while ((splitAt = buffer.indexOf('\n\n')) >= 0) {
      const packet = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt + 2);
      const parsed = parseSsePacket(packet);
      if (!parsed) continue;

      if (parsed.eventName === 'error') {
        throw new Error(parsed.payload?.error || 'Arena stream error.');
      }

      if (parsed.eventName === 'step' || parsed.eventName === 'run') {
        applyRuntimeEvent(parsed.payload);
      }
    }
  }

  if (buffer.trim()) {
    const parsed = parseSsePacket(buffer.trim());
    if (parsed?.eventName === 'step' || parsed?.eventName === 'run') {
      applyRuntimeEvent(parsed.payload);
    }
  }

  return {
    runId: runtimeRunState.runId,
    runStatus: runtimeRunState.runStatus,
    content: runtimeRunState.finalMessage || 'Done.',
    patch: runtimeRunState.patch,
    patchFiles: runtimeRunState.patchFiles
  };
}

function switchTab(mode) {
  const isChat = mode === 'chat';
  activeTab = isChat ? 'chat' : 'preview';

  chatPanel.classList.toggle('panel-visible', isChat);
  previewPanel.classList.toggle('panel-visible', !isChat);

  tabChat.classList.toggle('view-tab-active', isChat);
  tabPreview.classList.toggle('view-tab-active', !isChat);

  tabChat.setAttribute('aria-selected', String(isChat));
  tabPreview.setAttribute('aria-selected', String(!isChat));

  maybeRefreshPreviewPolling();
}

function previewStatusLabel(status) {
  if (status === 'provisioning') return 'Provisioning';
  if (status === 'syncing') return 'Syncing';
  if (status === 'running') return 'Running';
  if (status === 'error') return 'Error';
  return 'Idle';
}

function renderPreviewState() {
  const status = String(previewState.status || 'idle');
  const normalizedUrl = normalizePreviewUrl(previewState.url || '');

  previewStatus.textContent = previewStatusLabel(status);
  previewStatus.className = `preview-status preview-status-${status}`;

  if (normalizedUrl) {
    previewLink.hidden = false;
    previewLink.href = normalizedUrl;

    if (previewFrame.dataset.src !== normalizedUrl) {
      previewFrame.src = normalizedUrl;
      previewFrame.dataset.src = normalizedUrl;
    }
    previewEmpty.hidden = true;
  } else {
    previewLink.hidden = true;
    previewLink.href = '#';

    if (previewFrame.dataset.src) {
      previewFrame.removeAttribute('src');
      previewFrame.dataset.src = '';
    }
    previewEmpty.hidden = false;
  }
}

function kindFromPreviewOperation(operation) {
  const kind = String(operation?.kind || '').toLowerCase();

  if (kind === 'file' || kind === 'patch' || kind === 'heal') return 'edit';
  if (kind === 'install') return 'install';
  if (kind === 'build') return 'build';
  if (kind === 'diagnose' || kind === 'sandbox') return 'thought';
  if (kind === 'server') return 'server';
  if (kind === 'healthcheck' || kind === 'preview') return 'preview';
  if (kind === 'error') return 'error';
  return 'action';
}

function normalizePreviewOperationState(state) {
  if (state === 'completed' || state === 'error') return state;
  return 'running';
}

function syncPreviewOperations(operations) {
  for (const operation of Array.isArray(operations) ? operations : []) {
    if (!operation?.id) continue;

    const id = `preview:${String(operation.id)}`;
    const nextState = normalizePreviewOperationState(operation.state);
    const previousState = previewOperationStates.get(id);

    if (previousState === nextState) {
      continue;
    }

    previewOperationStates.set(id, nextState);

    const title = normalizeTextContent(operation.label || 'Working');
    const meta = nextState === 'error' ? normalizeTextContent(operation.error || 'Failed') : '';

    upsertActionMessage({
      id,
      kind: kindFromPreviewOperation(operation),
      title,
      state: nextState,
      meta
    });
  }
}

function applyPreviewState(nextState) {
  if (!nextState || typeof nextState !== 'object') return;

  previewState.sessionId = String(nextState.sessionId || previewState.sessionId || '');
  previewState.status = String(nextState.status || previewState.status || 'idle');
  previewState.url = normalizePreviewUrl(nextState.url || previewState.url || '');
  previewState.sandboxId = String(nextState.sandboxId || previewState.sandboxId || '');
  previewState.operations = Array.isArray(nextState.operations) ? nextState.operations : previewState.operations;
  previewState.error = typeof nextState.error === 'string' ? nextState.error : null;
  previewState.updatedAt = String(nextState.updatedAt || previewState.updatedAt || '');

  syncPreviewOperations(previewState.operations);
  renderPreviewState();
  maybeRefreshPreviewPolling();
}

function maybeRefreshPreviewPolling() {
  const shouldPoll =
    activeTab === 'preview' || previewState.status === 'provisioning' || previewState.status === 'syncing';

  if (shouldPoll && !previewPollTimer) {
    previewPollTimer = setInterval(() => {
      refreshPreviewState().catch(() => {});
    }, PREVIEW_STATE_POLL_MS);
    return;
  }

  if (!shouldPoll && previewPollTimer) {
    clearInterval(previewPollTimer);
    previewPollTimer = null;
  }
}

async function refreshPreviewState() {
  if (!previewState.sessionId) return;

  const response = await fetch(`/api/preview/state?sessionId=${encodeURIComponent(previewState.sessionId)}`);
  if (!response.ok) return;

  const data = await response.json();
  applyPreviewState(data);
}

async function syncPreviewFromPatch(patchText) {
  const patch = normalizePatchText(patchText);
  if (!patch) return;

  applyPreviewState({
    ...previewState,
    status: 'syncing',
    error: null
  });

  const response = await fetch('/api/preview/sync', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sessionId: previewState.sessionId,
      patch
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data?.error || 'Preview sync failed.');
  }

  applyPreviewState(data);
}

function stripPatchFromMessage(text) {
  return normalizeTextContent(text || '')
    .replace(/\*\*\* Begin Patch[\s\S]*?(?:\*\*\* End Patch|$)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function sendMessage(text) {
  if (isSending) return;

  const messageText = normalizeTextContent(text || '').trim();
  if (!messageText) return;

  isSending = true;
  sendButton.disabled = true;
  sendButton.textContent = '...';

  conversation.push({ role: 'user', content: messageText });
  appendTextMessage('user', messageText);

  try {
    const result = await readArenaStream(conversation);
    const assistantReply = stripPatchFromMessage(result.content || '') || 'Done.';

    conversation.push({ role: 'assistant', content: assistantReply });
    appendTextMessage('assistant', assistantReply);

    const patchText = normalizePatchText(result.patch || '');
    if (patchText) {
      syncPreviewFromPatch(patchText).catch((error) => {
        const message = error instanceof Error ? error.message : 'Preview sync failed.';
        upsertActionMessage({
          id: `preview:error:${Date.now()}`,
          kind: 'error',
          title: 'Preview failed',
          state: 'error',
          meta: message
        });
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    appendTextMessage('assistant', `Ошибка: ${message}`);
  } finally {
    isSending = false;
    sendButton.disabled = false;
    sendButton.textContent = 'Send';
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  autoResize();
  await sendMessage(text);
});

input.addEventListener('input', autoResize);

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

tabChat.addEventListener('click', () => switchTab('chat'));
tabPreview.addEventListener('click', () => switchTab('preview'));

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncViewportHeight);
  window.visualViewport.addEventListener('scroll', syncViewportHeight);
  syncViewportHeight();
}

previewState.sessionId = getOrCreatePreviewSessionId();
appendTextMessage('assistant', conversation[0].content);
autoResize();
switchTab('chat');
renderPreviewState();
refreshPreviewState().catch(() => {});
