const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const zlib = require('zlib');

/* ── Lightweight PDF text extractor (zero dependencies) ──
 * Parses PDF binary, inflates FlateDecode streams, extracts text operators.
 * Returns plain text. Not perfect for all PDFs but covers the vast majority. */
function extractPdfText(buf) {
  // Collect all stream contents (inflate FlateDecode, pass through others)
  const streams = [];
  let pos = 0;
  while (pos < buf.length) {
    const sIdx = buf.indexOf('stream\r\n', pos);
    const sIdx2 = buf.indexOf('stream\n', pos);
    let streamStart = -1;
    let headerLen = 0;
    if (sIdx >= 0 && (sIdx2 < 0 || sIdx <= sIdx2)) { streamStart = sIdx; headerLen = 8; }
    else if (sIdx2 >= 0) { streamStart = sIdx2; headerLen = 7; }
    if (streamStart < 0) break;

    const dataStart = streamStart + headerLen;
    // Find matching endstream
    let endIdx = buf.indexOf('endstream', dataStart);
    if (endIdx < 0) break;
    // Trim trailing \r\n or \n before endstream
    let dataEnd = endIdx;
    if (dataEnd > dataStart && buf[dataEnd - 1] === 0x0A) dataEnd--;
    if (dataEnd > dataStart && buf[dataEnd - 1] === 0x0D) dataEnd--;

    const raw = buf.slice(dataStart, dataEnd);
    // Check if FlateDecode by scanning the object dict before 'stream'
    const dictChunk = buf.slice(Math.max(0, streamStart - 512), streamStart).toString('latin1');
    if (/\/FlateDecode/.test(dictChunk)) {
      try { streams.push(zlib.inflateSync(raw)); } catch (_) { /* skip corrupt */ }
    } else {
      streams.push(raw);
    }
    pos = endIdx + 9;
  }

  // Extract text from PDF text operators: Tj, TJ, ', "
  const lines = [];
  for (const s of streams) {
    const txt = s.toString('latin1');
    // TJ array: [(text) 123 (text)] TJ
    const tjArr = /\[([^\]]*)\]\s*TJ/g;
    let m;
    while ((m = tjArr.exec(txt)) !== null) {
      const inner = m[1];
      const parts = [];
      const strRe = /\(([^)]*)\)/g;
      let sm;
      while ((sm = strRe.exec(inner)) !== null) parts.push(sm[1]);
      if (parts.length) lines.push(parts.join(''));
    }
    // Tj: (text) Tj
    const tj = /\(([^)]*)\)\s*Tj/g;
    while ((m = tj.exec(txt)) !== null) lines.push(m[1]);
    // ' and ": (text) '  or  aw ac (text) "
    const tq = /\(([^)]*)\)\s*['"]/g;
    while ((m = tq.exec(txt)) !== null) lines.push(m[1]);
  }

  // Unescape PDF string escapes
  const unescape = s => s
    .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\')
    .replace(/\\(\d{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));

  const result = lines.map(unescape).join('\n');
  return result.trim();
}

const _NERV_LOG = path.join(os.homedir(), 'nerv-debug.log');
function _log(m) { try { fs.appendFileSync(_NERV_LOG, '[' + new Date().toISOString() + '] ' + m + '\n'); } catch(_){} }
_log('=== extension.js loaded ===');

const VIEW_CONTAINER_ID = 'nerv-code-sidebar';
const VIEW_ID = 'nerv-code.sidebarView';
const VIEW_TITLE = 'NERV CODE';
const CONFIG_SECTION = 'nerv-code';
const DEFAULT_BACKEND_COMMAND = 'nerv';
const MAX_CONTEXT_CHARS = 6000;
const MAX_ROOT_ENTRIES = 16;
const MAX_VISIBLE_EDITORS = 8;
const MAX_SESSION_HISTORY = 20;
const THINKING_MODE_BUDGETS = Object.freeze({
  adaptive: null,
  off: 0,
  low: 2048,
  medium: 8192,
  high: 24576,
});
const BUILTIN_MODEL_PROFILES = [
  {
    id: 'minimax-m2-7',
    label: 'MiniMax M2.7',
    model: 'MiniMax-M2.7',
    description:
      'Preset for the official MiniMax Anthropic-compatible endpoint. Add ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN in settings.json -> nerv-code.modelProfiles[].env.',
    env: {},
  },
];

function getWorkingDirectory() {
  return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || os.homedir();
}

function normalizePath(value) {
  return value ? value.replace(/\\/g, '/') : value;
}

function getExtensionConfig() {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

function readConfigString(key, fallback = '') {
  const value = getExtensionConfig().get(key, fallback);
  return typeof value === 'string' ? value.trim() : fallback;
}

function resolveConfiguredPath(value) {
  if (!value) {
    return '';
  }
  return path.isAbsolute(value) ? value : path.resolve(getWorkingDirectory(), value);
}

function escapeHtmlText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncateText(value, maxLength = MAX_CONTEXT_CHARS) {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxLength)}\n... [truncated]`;
}

function listWorkspaceEntries(rootPath, limit = MAX_ROOT_ENTRIES) {
  try {
    return fs
      .readdirSync(rootPath, { withFileTypes: true })
      .sort((left, right) => {
        if (left.isDirectory() && !right.isDirectory()) {
          return -1;
        }
        if (!left.isDirectory() && right.isDirectory()) {
          return 1;
        }
        return left.name.localeCompare(right.name);
      })
      .slice(0, limit)
      .map(entry => `${entry.isDirectory() ? 'dir' : 'file'}:${entry.name}`);
  } catch (_error) {
    return [];
  }
}

function getSelectionContext(editor) {
  if (!editor || !editor.selection || editor.selection.isEmpty) {
    return null;
  }

  const preview = truncateText(editor.document.getText(editor.selection));
  if (!preview) {
    return null;
  }

  return {
    startLine: editor.selection.start.line + 1,
    endLine: editor.selection.end.line + 1,
    preview,
    charCount: preview.length,
  };
}

function getVisibleExcerpt(editor) {
  if (!editor?.visibleRanges?.length) {
    return null;
  }

  const firstRange = editor.visibleRanges[0];
  const startLine = Math.max(0, firstRange.start.line);
  const endLine = Math.min(editor.document.lineCount - 1, firstRange.end.line);
  if (endLine < startLine) {
    return null;
  }

  const endCharacter = editor.document.lineAt(endLine).text.length;
  const range = new vscode.Range(startLine, 0, endLine, endCharacter);
  const preview = truncateText(editor.document.getText(range));
  if (!preview) {
    return null;
  }

  return {
    startLine: startLine + 1,
    endLine: endLine + 1,
    preview,
  };
}

function collectActiveEditorContext() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    return null;
  }

  return {
    path: normalizePath(editor.document.uri.fsPath),
    language: editor.document.languageId || 'plaintext',
    lineCount: editor.document.lineCount,
    cursorLine: editor.selection.active.line + 1,
    cursorColumn: editor.selection.active.character + 1,
    selection: getSelectionContext(editor),
    visibleExcerpt: getVisibleExcerpt(editor),
  };
}

function collectVisibleEditors() {
  const seen = new Set();
  const editors = [];

  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.scheme !== 'file') {
      continue;
    }

    const filePath = normalizePath(editor.document.uri.fsPath);
    if (!filePath || seen.has(filePath)) {
      continue;
    }

    seen.add(filePath);
    editors.push({
      path: filePath,
      language: editor.document.languageId || 'plaintext',
    });

    if (editors.length >= MAX_VISIBLE_EDITORS) {
      break;
    }
  }

  return editors;
}

function collectWorkspaceContext() {
  const cwd = normalizePath(getWorkingDirectory());
  return {
    cwd,
    folders: (vscode.workspace.workspaceFolders || []).map(folder => normalizePath(folder.uri.fsPath)),
    topLevelEntries: cwd ? listWorkspaceEntries(cwd) : [],
  };
}

function collectIdeContext() {
  return {
    activeEditor: collectActiveEditorContext(),
    visibleEditors: collectVisibleEditors(),
    workspace: collectWorkspaceContext(),
  };
}

function sanitizeEnvMap(rawEnv) {
  if (!rawEnv || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) {
    return {};
  }

  const env = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (!key || typeof key !== 'string') {
      continue;
    }
    if (typeof value !== 'string') {
      continue;
    }
    env[key] = value;
  }
  return env;
}

function sanitizeModelProfiles(rawProfiles) {
  if (!Array.isArray(rawProfiles)) {
    return [];
  }

  return rawProfiles
    .map((rawProfile, index) => {
      if (!rawProfile || typeof rawProfile !== 'object') {
        return null;
      }

      const id =
        typeof rawProfile.id === 'string' && rawProfile.id.trim()
          ? rawProfile.id.trim()
          : `profile-${index + 1}`;
      const label =
        typeof rawProfile.label === 'string' && rawProfile.label.trim()
          ? rawProfile.label.trim()
          : id;
      const model =
        typeof rawProfile.model === 'string' && rawProfile.model.trim()
          ? rawProfile.model.trim()
          : 'default';
      const description =
        typeof rawProfile.description === 'string' && rawProfile.description.trim()
          ? rawProfile.description.trim()
          : '';

      return {
        id,
        label,
        model,
        description,
        env: sanitizeEnvMap(rawProfile.env),
      };
    })
    .filter(Boolean);
}

function mergeModelProfiles(configuredProfiles) {
  const mergedProfiles = new Map();

  for (const profile of BUILTIN_MODEL_PROFILES) {
    mergedProfiles.set(profile.id, {
      ...profile,
      env: { ...(profile.env || {}) },
    });
  }

  for (const profile of configuredProfiles) {
    const existing = mergedProfiles.get(profile.id);
    mergedProfiles.set(profile.id, {
      ...existing,
      ...profile,
      env: {
        ...(existing?.env || {}),
        ...(profile.env || {}),
      },
    });
  }

  return Array.from(mergedProfiles.values());
}

function stripProfileSecrets(profile) {
  return {
    id: profile.id,
    label: profile.label,
    model: profile.model,
    description: profile.description,
    isThirdParty: Boolean(profile.env && profile.env.ANTHROPIC_BASE_URL),
  };
}

function normalizeModelInfo(model) {
  return {
    value: typeof model?.value === 'string' ? model.value : 'default',
    displayName:
      typeof model?.displayName === 'string' && model.displayName
        ? model.displayName
        : typeof model?.value === 'string'
          ? model.value
          : 'Default',
    description: typeof model?.description === 'string' ? model.description : '',
    supportsEffort: Boolean(model?.supportsEffort),
    supportedEffortLevels: Array.isArray(model?.supportedEffortLevels)
      ? model.supportedEffortLevels
      : [],
  };
}

/**
 * Filter out [1m] (extended 1M context) model variants.
 * Replace them with standard-context equivalents if no standard version exists.
 */
function filterExtendedContextModels(models) {
  const standardValues = new Set(models.map(m => m.value).filter(v => !v.endsWith('[1m]')));
  const result = [];
  for (const model of models) {
    if (model.value.endsWith('[1m]')) {
      const baseValue = model.value.replace('[1m]', '');
      // Only add a standard replacement if no standard version already exists
      if (!standardValues.has(baseValue)) {
        result.push({
          ...model,
          value: baseValue,
          displayName: model.displayName?.replace('[1m]', '').replace('[1M]', '') || baseValue,
          description: model.description?.replace('[1m]', '').replace('[1M]', '') || '',
        });
        standardValues.add(baseValue);
      }
      // Skip the [1m] variant entirely
    } else {
      result.push(model);
    }
  }
  return result;
}

function sanitizeThinkingMode(value) {
  if (typeof value !== 'string') {
    return 'adaptive';
  }

  const normalized = value.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(THINKING_MODE_BUDGETS, normalized)
    ? normalized
    : 'adaptive';
}

/**
 * 创建初始状态对象
 * 包含所有 UI 和后端交互需要的状态字段
 * @returns {object} 初始状态对象
 */
function createInitialState() {
  return {
    cwd: normalizePath(getWorkingDirectory()),
    backendStatus: 'idle',     // 后端状态: idle|starting|online|closed|error
    sessionState: 'idle',      // 会话状态: idle|running|requires_action
    busy: false,               // 是否正在处理
    sessionId: null,           // 当前会话 ID
    runtime: null,             // 运行时信息（模型、工具、MCP 等）
    account: null,             // 账户信息
    rateLimit: null,           // 频率限制信息
    pendingPermission: null,   // 待审批的工具权限请求
    lastError: null,           // 最后一次错误信息
    lastResult: null,          // 最后一次回合结果
    messages: [],              // 消息历史记录
    activity: [],              // 操作日志
    stderr: [],                // 标准错误输出
    ideContext: collectIdeContext(), // IDE 上下文
    availableModels: [],       // 可用模型列表
    modelProfiles: [],         // 模型配置列表
    defaultProfileId: null,    // 默认模型配置 ID
    activeProfileId: null,     // 当前激活的模型配置 ID
    selectedModel: 'default',  // 选中的模型
    streamingAssistantText: '', // 流式回复文本
    streamingThinkingText: '',  // 流式思考过程文本
    pendingModelValue: null,   // 待应用的模型值
    pendingThinkingMode: null, // 待应用的思考模式
    interactionStatus: null,   // 交互状态指示
    ideContextEnabled: true,   // IDE 上下文是否启用
    planModeEnabled: false,    // Plan 模式是否启用
    thinkingMode: 'adaptive',  // 思考模式
    sessionHistory: [],        // 会话历史归档
    historyPreview: null,      // 历史预览内容
    /* ── Usage 追踪 ── */
    usageHistory: [],          // 每轮 usage 记录 [{cost, durationMs, durationApiMs, turnIndex, timestamp}]
    totalCostUsd: 0,           // 会话累计花费
    totalTurns: 0,             // 会话累计轮数
    utilization: null,         // 配额数据 {five_hour, seven_day, seven_day_sonnet, extra_usage}
    /* ── 新增状态字段 ── */
    toolDenylist: [],          // 工具拒绝列表（精细工具控制）
    todos: [],                 // 任务列表（从后端 task 事件收集）
    agents: [],                // 子代理列表（Agent 子进程追踪）
    hooks: [],                 // Hooks 事件日志
    parallelSessions: [],      // 并行会话列表
    activeSessionId: null,     // 当前活动的会话 ID（多会话模式）
    loginInProgress: false,    // Anthropic OAuth login in progress
    pendingLoginForModel: null, // Set when Claude model switch failed - triggers login screen
  };
}

function buildPromptSubmissionResult(accepted, reason = '') {
  return {
    accepted: Boolean(accepted),
    reason: typeof reason === 'string' ? reason : '',
  };
}

function getBuiltinFallbackModels() {
  return [
    normalizeModelInfo({ value: 'default', displayName: 'Default', description: 'Use the CLI default model' }),
    normalizeModelInfo({ value: 'sonnet', displayName: 'Sonnet', description: 'Claude Sonnet alias' }),
    normalizeModelInfo({ value: 'opus', displayName: 'Opus', description: 'Claude Opus alias' }),
    normalizeModelInfo({ value: 'haiku', displayName: 'Haiku', description: 'Claude Haiku alias' }),
  ];
}

function buildModelSelectMarkup(profiles, models, defaultProfileId) {
  const profileOptions = Array.isArray(profiles)
    ? profiles.map(profile => ({
        value: profile.id,
        label:
          defaultProfileId && profile.id === defaultProfileId
            ? `${profile.label} (default)`
            : profile.label,
      }))
    : [];
  const modelOptions = Array.isArray(models)
    ? models
        .filter(model => !(profileOptions.length > 0 && model.value === 'default'))
        .map(model => ({
          value: model.value,
          label: model.displayName || model.value,
        }))
    : [];
  const options = [...profileOptions, ...modelOptions];

  if (options.length === 0) {
    return '<option value="default">Default</option>';
  }

  return options
    .map(
      option =>
        `<option value="${escapeHtmlText(option.value)}">${escapeHtmlText(option.label)}</option>`,
    )
    .join('');
}

function sanitizeHistoryMessage(message) {
  if (!message || typeof message !== 'object') {
    return null;
  }

  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (!text) {
    return null;
  }

  return {
    id: typeof message.id === 'string' ? message.id : randomUUID(),
    role: message.role === 'user' ? 'user' : 'assistant',
    text: truncateText(text, 4000),
    tone: typeof message.tone === 'string' ? message.tone : 'assistant',
    timestamp:
      typeof message.timestamp === 'string' && message.timestamp
        ? message.timestamp
        : new Date().toISOString(),
  };
}

function sanitizeHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const messages = Array.isArray(entry.messages)
    ? entry.messages.map(sanitizeHistoryMessage).filter(Boolean)
    : [];
  if (messages.length === 0) {
    return null;
  }

  const title =
    typeof entry.title === 'string' && entry.title.trim()
      ? entry.title.trim()
      : 'Untitled session';
  const preview =
    typeof entry.preview === 'string' && entry.preview.trim()
      ? entry.preview.trim()
      : messages[0].text.slice(0, 120);

  return {
    id: typeof entry.id === 'string' && entry.id ? entry.id : randomUUID(),
    title,
    preview,
    updatedAt:
      typeof entry.updatedAt === 'string' && entry.updatedAt
        ? entry.updatedAt
        : new Date().toISOString(),
    cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
    model: typeof entry.model === 'string' ? entry.model : '',
    sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : '',
    messages,
  };
}

function summarizeHistoryEntry(entry) {
  return {
    id: entry.id,
    title: entry.title,
    preview: entry.preview,
    updatedAt: entry.updatedAt,
    cwd: entry.cwd,
    model: entry.model,
    messageCount: entry.messages.length,
  };
}

function buildSessionTitle(messages) {
  const firstUserMessage = messages.find(message => message.role === 'user');
  const firstLine = firstUserMessage?.text?.split(/\r?\n/)[0]?.trim() || '';
  if (!firstLine) {
    return 'Untitled session';
  }
  return firstLine.length > 44 ? `${firstLine.slice(0, 44)}...` : firstLine;
}

function buildSessionPreview(messages) {
  const lastAssistantMessage = [...messages].reverse().find(message => message.role === 'assistant');
  const source = lastAssistantMessage || messages[0];
  const firstLine = source?.text?.split(/\r?\n/)[0]?.trim() || '';
  return firstLine.length > 100 ? `${firstLine.slice(0, 100)}...` : firstLine;
}

function resolveNodeExecutable() {
  return resolveConfiguredPath(readConfigString('nodePath')) || 'node';
}

function getCliPathCandidates() {
  const cwd = getWorkingDirectory();
  return Array.from(
    new Set([
      path.resolve(cwd, 'dist', 'cli.js'),
      path.resolve(cwd, '..', 'dist', 'cli.js'),
      path.resolve(__dirname, '..', 'dist', 'cli.js'),
      path.resolve(__dirname, 'dist', 'cli.js'),
    ]),
  );
}

function resolveBackendLaunchSpec() {
  const configuredCliPath = resolveConfiguredPath(readConfigString('cliPath'));
  if (configuredCliPath) {
    return {
      type: 'cli',
      command: resolveNodeExecutable(),
      args: [configuredCliPath],
      label: normalizePath(configuredCliPath),
      exists: fs.existsSync(configuredCliPath),
    };
  }

  const discoveredCliPath = getCliPathCandidates().find(candidate => fs.existsSync(candidate));
  if (discoveredCliPath) {
    return {
      type: 'cli',
      command: resolveNodeExecutable(),
      args: [discoveredCliPath],
      label: normalizePath(discoveredCliPath),
      exists: true,
    };
  }

  const command = readConfigString('command', DEFAULT_BACKEND_COMMAND) || DEFAULT_BACKEND_COMMAND;
  return {
    type: 'command',
    command,
    args: [],
    label: command,
    exists: true,
  };
}

function formatLaunchError(error, launchSpec) {
  if (error?.code === 'ENOENT') {
    if (launchSpec?.type === 'command') {
      return `Command "${launchSpec.label}" was not found. Install the NERV CLI on PATH or set nerv-code.cliPath in VS Code settings.`;
    }
    return `Node.js executable "${normalizePath(launchSpec?.command || 'node')}" was not found. Install Node.js or update nerv-code.nodePath in VS Code settings.`;
  }

  if (typeof error?.message === 'string' && error.message.trim()) {
    return error.message.trim();
  }

  return 'Unknown backend launch error';
}

/**
 * 从助手消息中提取文本内容
 * 同时提取 thinking（思考过程）和 text（正文）内容
 * 如果有 thinking 块，用 <thinking> 标签包裹以便前端解析
 */
function extractAssistantText(message) {
  if (!message || !Array.isArray(message.content)) {
    return '';
  }

  const thinkingParts = [];
  const textParts = [];
  for (const block of message.content) {
    // 提取思考过程内容
    if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
      thinkingParts.push(block.thinking.trim());
    }
    // 提取正文内容
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      textParts.push(block.text.trim());
    }
  }

  let result = '';
  // 如果有思考过程，用 <thinking> 标签包裹
  if (thinkingParts.length > 0) {
    result += `<thinking>${thinkingParts.join('\n\n')}</thinking>\n\n`;
  }
  result += textParts.join('\n\n');
  return result.trim();
}

function summarizeRuntime(message) {
  return {
    claudeCodeVersion: message.claude_code_version || 'unknown',
    model: message.model || 'unknown',
    permissionMode: message.permissionMode || 'default',
    tools: Array.isArray(message.tools) ? message.tools : [],
    mcpServers: Array.isArray(message.mcp_servers) ? message.mcp_servers : [],
    slashCommands: Array.isArray(message.slash_commands) ? message.slash_commands : [],
    outputStyle: message.output_style || 'default',
    skills: Array.isArray(message.skills) ? message.skills : [],
    plugins: Array.isArray(message.plugins) ? message.plugins : [],
    cwd: normalizePath(message.cwd || getWorkingDirectory()),
  };
}

function formatRateLimitSummary(rateLimit) {
  if (!rateLimit || !rateLimit.status) {
    return null;
  }
  if (rateLimit.status === 'rejected') {
    return 'Rate limited';
  }
  if (rateLimit.status === 'allowed_warning') {
    return 'Usage warning';
  }
  return 'Online';
}

class NervCodeController {
  constructor(context) {
    this.context = context;
    this.view = null;
    this.webviewReady = false;
    this.process = null;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.isStopping = false;
    this.pendingFocusInput = false;
    this.streamingTextBlocks = new Map();
    this.lastLaunchSpec = null;
    this.pendingModelChange = null;
    this.pendingThinkingChange = null;
    this.pendingModelRequestId = null;
    this.pendingThinkingRequestId = null;
    this.interactionStatus = null;
    this.state = createInitialState();
    this.modelProfiles = [];
    this.sessionHistory = this.loadSessionHistory();
    _log('constructor: sessionHistory count=' + this.sessionHistory.length);
    this.historyPreviewId = null;
    this.activeProfileId = null;
    this.activeEnvOverrides = {};
    this.defaultProfileId = null;
    this.pendingModelSelection = null;
    this.ideContextEnabled = this.context.workspaceState.get('nerv-code.ideContextEnabled', true) !== false;
    this.thinkingMode = sanitizeThinkingMode(
      this.context.workspaceState.get('nerv-code.thinkingMode', 'adaptive'),
    );
    this.pendingThinkingMode = null;
    this.permissionMode = this.context.workspaceState.get('nerv-code.permissionMode', 'default');
    this.planModeEnabled = false;
    /* ── 新增功能字段 ── */
    this.toolDenylist = this.context.workspaceState.get('nerv-code.toolDenylist', []);  // 工具拒绝列表（持久化）
    this.todos = [];                   // 当前任务列表（从后端 task 事件收集）
    this.agents = [];                  // 子代理追踪列表
    this.hooks = [];                   // Hooks 事件日志（最近 30 条）
    this.parallelSessions = [];        // 并行会话元数据列表
    this.activeSessionId = null;       // 当前活动会话 ID
    this.applyInteractionStateToState();
    this.reloadModelProfiles();
    this.syncHistoryState();
  }

  async reveal() {
    const commands = await vscode.commands.getCommands(true);
    if (commands.includes('workbench.action.openAuxiliaryBar')) {
      await vscode.commands.executeCommand('workbench.action.openAuxiliaryBar');
    }

    await vscode.commands.executeCommand(`workbench.view.extension.${VIEW_CONTAINER_ID}`);
    this.pendingFocusInput = true;
    this.refreshIdeContext();
    this.ensureProcess();
    this.focusInput();
  }

  resolveWebviewView(webviewView) {
    _log('resolveWebviewView called');
    this.view = webviewView;
    this.webviewReady = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(message => {
      _log('onDidReceiveMessage: type=' + message?.type);
      void this.handleWebviewMessage(message);
    });

    this.refreshIdeContext();
    this.ensureProcess();
  }

  refreshIdeContext() {
    this.state.cwd = normalizePath(getWorkingDirectory());
    this.state.ideContext = collectIdeContext();
    this.postState();
  }

  loadSessionHistory() {
    const storedHistory = this.context.workspaceState.get('nerv-code.sessionHistory', []);
    if (!Array.isArray(storedHistory)) {
      return [];
    }
    return storedHistory.map(sanitizeHistoryEntry).filter(Boolean).slice(0, MAX_SESSION_HISTORY);
  }

  syncHistoryState() {
    this.state.sessionHistory = this.sessionHistory.map(summarizeHistoryEntry);
    this.state.historyPreview =
      this.historyPreviewId
        ? this.sessionHistory.find(entry => entry.id === this.historyPreviewId) || null
        : null;
  }

  async persistSessionHistory() {
    await this.context.workspaceState.update('nerv-code.sessionHistory', this.sessionHistory);
  }

  async archiveCurrentSession() {
    if (!Array.isArray(this.state.messages) || this.state.messages.length === 0) {
      return;
    }

    const messages = this.state.messages.map(sanitizeHistoryMessage).filter(Boolean);
    if (messages.length === 0) {
      return;
    }

    const entry = {
      id: randomUUID(),
      title: buildSessionTitle(messages),
      preview: buildSessionPreview(messages),
      updatedAt: new Date().toISOString(),
      cwd: this.state.cwd || '',
      model: this.state.runtime?.model || this.state.selectedModel || 'default',
      sessionId: this.state.sessionId || '',
      messages,
    };

    this.sessionHistory.unshift(entry);
    this.sessionHistory = this.sessionHistory.slice(0, MAX_SESSION_HISTORY);
    this.syncHistoryState();
    await this.persistSessionHistory();
  }

  async openHistoryEntry(id) {
    const entry = this.sessionHistory.find(item => item.id === id);
    if (!entry) {
      return;
    }
    this.historyPreviewId = entry.id;
    this.syncHistoryState();
    this.postState();
  }

  async restoreHistoryEntry(id) {
    const entry = this.sessionHistory.find(item => item.id === id);
    if (!entry || !Array.isArray(entry.messages) || entry.messages.length === 0) {
      return;
    }

    await this.archiveCurrentSession();
    await this.restartSession();

    this.state.messages = entry.messages.map(msg => ({
      id: msg.id || randomUUID(),
      role: msg.role,
      text: msg.text,
      tone: msg.tone || msg.role,
      timestamp: msg.timestamp || new Date().toISOString(),
    }));

    this.historyPreviewId = null;
    this.syncHistoryState();
    this.appendActivity('info', `Restored session: ${entry.title}`);
    this.postState();
    this.ensureProcess();
  }

  clearHistoryPreview() {
    this.historyPreviewId = null;
    this.syncHistoryState();
    this.postState();
  }

  /**
   * 将交互层状态同步到主状态对象
   * 确保 webview 能收到最新的控制状态
   */
  applyInteractionStateToState() {
    this.state.ideContextEnabled = this.ideContextEnabled;
    this.state.planModeEnabled = this.planModeEnabled;
    this.state.thinkingMode = this.thinkingMode;
    this.state.permissionMode = this.permissionMode;
    this.state.toolDenylist = this.toolDenylist || [];       // 工具拒绝列表
    this.state.todos = this.todos || [];                     // 任务列表
    this.state.agents = this.agents || [];                   // 子代理列表
    this.state.hooks = this.hooks || [];                     // Hooks 事件
    this.state.parallelSessions = this.parallelSessions || []; // 并行会话
    this.state.activeSessionId = this.activeSessionId || this.state.sessionId; // 活动会话
  }

  syncTransientStateToState() {
    this.state.pendingModelValue = this.pendingModelChange?.requestedValue || null;
    this.state.pendingThinkingMode = this.pendingThinkingChange?.requestedMode || null;
    this.state.interactionStatus = this.interactionStatus ? { ...this.interactionStatus } : null;
  }

  setInteractionStatus(control, status, message) {
    this.interactionStatus = {
      control,
      status,
      message,
      timestamp: new Date().toISOString(),
    };
    this.syncTransientStateToState();
  }

  clearInteractionStatus(control) {
    if (!this.interactionStatus) {
      return;
    }
    if (control && this.interactionStatus.control !== control) {
      return;
    }
    this.interactionStatus = null;
    this.syncTransientStateToState();
  }

  resolveThinkingModeLabel(mode) {
    switch (sanitizeThinkingMode(mode)) {
      case 'off':
        return 'Off';
      case 'low':
        return 'Low';
      case 'medium':
        return 'Medium';
      case 'high':
        return 'High';
      default:
        return 'Auto';
    }
  }

  resolveModelOptionLabel(value) {
    const normalizedValue = typeof value === 'string' && value.trim() ? value.trim() : 'default';
    const profile = this.modelProfiles.find(item => item.id === normalizedValue);
    if (profile) {
      return profile.label;
    }

    const runtimeModel = (this.state.availableModels || []).find(model => model.value === normalizedValue);
    if (runtimeModel) {
      return runtimeModel.displayName || runtimeModel.value;
    }

    if (normalizedValue === 'default') {
      return 'Default';
    }

    return normalizedValue;
  }

  commitPendingModelChange() {
    console.log('[NERV-DEBUG] commitPendingModelChange called, pendingModelChange:', JSON.stringify(this.pendingModelChange?.targetModel));
    if (!this.pendingModelChange) {
      this.pendingModelRequestId = null;
      return;
    }

    const change = this.pendingModelChange;
    this.activeProfileId = change.targetProfileId;
    this.activeEnvOverrides = { ...(change.targetEnvOverrides || {}) };
    this.state.selectedModel = change.targetModel;
    if (this.state.runtime) {
      this.state.runtime = {
        ...this.state.runtime,
        model: change.targetModel,
      };
    }
    this.pendingModelRequestId = null;
    this.pendingModelSelection = null;
    this.pendingModelChange = null;
    this.applyStaticConfigurationToState();
    void this.context.workspaceState.update('nerv-code.activeProfileId', this.activeProfileId || '');
    this.appendActivity('info', `Model applied: ${change.label}.`);
    this.setInteractionStatus('model', 'success', `Model set to ${change.label}.`);
  }

  failPendingModelChange(detail, options = {}) {
    const change = this.pendingModelChange;
    this.pendingModelRequestId = null;
    this.pendingModelSelection = null;
    this.pendingModelChange = null;

    if (!change) {
      this.state.lastError = detail;
      this.appendActivity('error', detail);
      this.setInteractionStatus('model', 'error', detail);
      return;
    }

    // If we failed switching to a non-third-party model (Claude), show login screen
    const targetIsThirdParty = Boolean(change.targetEnvOverrides?.ANTHROPIC_BASE_URL);
    if (!targetIsThirdParty) {
      this.state.pendingLoginForModel = {
        profileId: change.targetProfileId,
        model: change.targetModel,
        label: change.label,
        envOverrides: change.targetEnvOverrides,
      };
    }

    this.activeProfileId = change.previous.activeProfileId;
    this.activeEnvOverrides = { ...(change.previous.activeEnvOverrides || {}) };
    this.state.selectedModel = change.previous.selectedModel || 'default';
    if (this.state.runtime) {
      this.state.runtime = {
        ...this.state.runtime,
        model: change.previous.runtimeModel || this.state.runtime.model,
      };
    }
    this.applyStaticConfigurationToState();
    void this.context.workspaceState.update('nerv-code.activeProfileId', this.activeProfileId || '');
    this.state.lastError = detail;
    this.appendActivity('error', detail);
    this.setInteractionStatus('model', 'error', detail);

    if (change.requiresRestart && options.restoreSession !== false) {
      void this.restartSession();
    }
  }

  commitPendingThinkingChange() {
    if (!this.pendingThinkingChange) {
      this.pendingThinkingRequestId = null;
      return;
    }

    const change = this.pendingThinkingChange;
    this.thinkingMode = change.requestedMode;
    this.pendingThinkingMode = null;
    this.pendingThinkingRequestId = null;
    this.pendingThinkingChange = null;
    this.applyInteractionStateToState();
    void this.context.workspaceState.update('nerv-code.thinkingMode', this.thinkingMode);
    this.appendActivity('info', `Thinking mode applied: ${this.resolveThinkingModeLabel(this.thinkingMode)}.`);
    this.setInteractionStatus(
      'thinking',
      'success',
      `Thinking set to ${this.resolveThinkingModeLabel(this.thinkingMode)}.`,
    );
  }

  failPendingThinkingChange(detail) {
    const previousMode = this.pendingThinkingChange?.previousMode || this.thinkingMode;
    this.pendingThinkingRequestId = null;
    this.pendingThinkingMode = null;
    this.pendingThinkingChange = null;
    this.thinkingMode = previousMode;
    this.applyInteractionStateToState();
    this.state.lastError = detail;
    this.appendActivity('error', detail);
    this.setInteractionStatus('thinking', 'error', detail);
  }

  clearStreamingAssistant() {
    this.streamingTextBlocks.clear();
    this.state.streamingAssistantText = '';
    this.streamingThinkingText = '';              // 清除思考过程文本
    this.state.streamingThinkingText = '';         // 清除状态中的思考文本
    this.streamingBlockTypes = {};                 // 清除块类型追踪
  }

  updateStreamingAssistant(index, text) {
    if (typeof text !== 'string') {
      return;
    }

    const blockIndex =
      Number.isInteger(index) && index >= 0 ? index : this.streamingTextBlocks.size;
    this.streamingTextBlocks.set(blockIndex, text);
    this.state.streamingAssistantText = [...this.streamingTextBlocks.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, value]) => value)
      .join('\n\n')
      .trim();
  }

  getSelectedProfile() {
    if (!this.activeProfileId) {
      return null;
    }
    return this.modelProfiles.find(profile => profile.id === this.activeProfileId) || null;
  }

  applyStaticConfigurationToState() {
    this.state.modelProfiles = this.modelProfiles.map(stripProfileSecrets);
    this.state.defaultProfileId = this.defaultProfileId;
    this.state.activeProfileId = this.activeProfileId;
    if (this.activeProfileId) {
      this.state.selectedModel = this.getSelectedProfile()?.model || this.state.selectedModel || 'default';
    } else if (!this.state.selectedModel) {
      this.state.selectedModel = 'default';
    }
  }

  reloadModelProfiles() {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const previousEnvSignature = JSON.stringify(this.activeEnvOverrides || {});
    const profiles = mergeModelProfiles(sanitizeModelProfiles(config.get('modelProfiles', [])));
    const configuredDefaultProfile = config.get('defaultProfile', '');

    this.modelProfiles = profiles;

    if (profiles.length === 0) {
      const fallbackModel = this.state.selectedModel || 'default';
      this.defaultProfileId = null;
      this.state.defaultProfileId = null;
      this.activeProfileId = null;
      this.activeEnvOverrides = {};
      this.pendingModelSelection = fallbackModel;
      this.applyStaticConfigurationToState();
      void this.context.workspaceState.update('nerv-code.activeProfileId', '');

      const nextEnvSignature = JSON.stringify(this.activeEnvOverrides || {});
      if (
        this.process &&
        this.process.exitCode == null &&
        !this.process.killed &&
        previousEnvSignature !== nextEnvSignature
      ) {
        void this.restartSession();
        return;
      }

      this.postState();
      return;
    }

    const resolvedDefaultProfileId =
      typeof configuredDefaultProfile === 'string' &&
      configuredDefaultProfile &&
      profiles.some(profile => profile.id === configuredDefaultProfile)
        ? configuredDefaultProfile
        : profiles[0]?.id || null;
    this.defaultProfileId = resolvedDefaultProfileId;
    this.state.defaultProfileId = resolvedDefaultProfileId;

    const candidateIds = [this.activeProfileId, resolvedDefaultProfileId].filter(Boolean);

    const selectedProfileId =
      candidateIds.find(id => profiles.some(profile => profile.id === id)) || profiles[0]?.id || null;

    this.activeProfileId = selectedProfileId;
    this.activeEnvOverrides = this.getSelectedProfile()?.env || {};
    this.applyStaticConfigurationToState();
    void this.context.workspaceState.update('nerv-code.activeProfileId', this.activeProfileId || '');

    const nextEnvSignature = JSON.stringify(this.activeEnvOverrides || {});
    if (
      this.process &&
      this.process.exitCode == null &&
      !this.process.killed &&
      previousEnvSignature !== nextEnvSignature
    ) {
      this.pendingModelSelection = this.getSelectedProfile()?.model || 'default';
      void this.restartSession();
      return;
    }

    this.postState();
  }

  buildSpawnEnv() {
    const env = { ...process.env };
    const envOverrides =
      this.pendingModelChange?.targetEnvOverrides && this.pendingModelChange.requiresRestart
        ? this.pendingModelChange.targetEnvOverrides
        : this.activeEnvOverrides;

    for (const [key, value] of Object.entries(envOverrides || {})) {
      env[key] = value;
    }

    if (Object.keys(envOverrides || {}).length > 0) {
      env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
    }

    return env;
  }

  buildPromptWithIdeContext(prompt) {
    const trimmedPrompt = typeof prompt === 'string' ? prompt.trim() : '';
    if (!trimmedPrompt) {
      return '';
    }

    if (!this.ideContextEnabled || trimmedPrompt.startsWith('/')) {
      return trimmedPrompt;
    }

    const ideContext = this.state.ideContext || collectIdeContext();
    const sections = ['Use the following VS Code IDE context when it is relevant to the request.'];

    if (ideContext.workspace?.cwd) {
      sections.push(`Workspace cwd: ${ideContext.workspace.cwd}`);
    }

    if (ideContext.workspace?.folders?.length) {
      sections.push(`Workspace folders: ${ideContext.workspace.folders.join(', ')}`);
    }

    if (ideContext.workspace?.topLevelEntries?.length) {
      sections.push(`Workspace root entries: ${ideContext.workspace.topLevelEntries.join(', ')}`);
    }

    if (ideContext.visibleEditors?.length) {
      sections.push(
        `Visible editors: ${ideContext.visibleEditors
          .map(editor => `${editor.path} (${editor.language})`)
          .join(', ')}`,
      );
    }

    if (ideContext.activeEditor) {
      sections.push(`Active file: ${ideContext.activeEditor.path}`);
      sections.push(`Active language: ${ideContext.activeEditor.language}`);
      sections.push(
        `Cursor position: line ${ideContext.activeEditor.cursorLine}, column ${ideContext.activeEditor.cursorColumn}`,
      );

      if (ideContext.activeEditor.selection?.preview) {
        sections.push(
          `Selected text (lines ${ideContext.activeEditor.selection.startLine}-${ideContext.activeEditor.selection.endLine}):\n\`\`\`\n${ideContext.activeEditor.selection.preview}\n\`\`\``,
        );
      } else if (ideContext.activeEditor.visibleExcerpt?.preview) {
        sections.push(
          `Visible excerpt (lines ${ideContext.activeEditor.visibleExcerpt.startLine}-${ideContext.activeEditor.visibleExcerpt.endLine}):\n\`\`\`\n${ideContext.activeEditor.visibleExcerpt.preview}\n\`\`\``,
        );
      }
    }

    sections.push(`User request:\n${trimmedPrompt}`);
    return sections.join('\n\n');
  }

  getThinkingBudget(mode) {
    return THINKING_MODE_BUDGETS[sanitizeThinkingMode(mode)];
  }

  requestThinkingMode(mode, options = {}) {
    const nextMode = sanitizeThinkingMode(mode);
    const requestId = randomUUID();
    const sent = this.sendMessage({
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'set_max_thinking_tokens',
        max_thinking_tokens: this.getThinkingBudget(nextMode),
      },
    });

    if (sent && options.track !== false) {
      this.pendingThinkingRequestId = requestId;
    }

    return sent ? requestId : null;
  }

  async handleThinkingModeSelection(value) {
    const nextMode = sanitizeThinkingMode(value);
    if (
      this.pendingThinkingChange?.requestedMode === nextMode ||
      (!this.pendingThinkingChange && this.thinkingMode === nextMode)
    ) {
      return;
    }

    this.pendingThinkingChange = {
      requestedMode: nextMode,
      previousMode: this.thinkingMode,
    };
    this.pendingThinkingMode = nextMode;
    this.setInteractionStatus(
      'thinking',
      'pending',
      `Applying thinking: ${this.resolveThinkingModeLabel(nextMode)}...`,
    );
    this.postState();

    this.ensureProcess();
    if (
      this.process &&
      this.state.backendStatus === 'online' &&
      this.requestThinkingMode(nextMode, { track: true })
    ) {
      this.pendingThinkingMode = null;
      this.postState();
      return;
    }

    if (!this.process) {
      this.failPendingThinkingChange('Failed to apply thinking mode.');
      this.postState();
    }
  }

  async handlePermissionModeSelection(value) {
    const validModes = ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'];
    const nextMode = validModes.includes(value) ? value : 'default';
    if (this.permissionMode === nextMode) {
      return;
    }
    this.permissionMode = nextMode;
    this.applyInteractionStateToState();
    await this.context.workspaceState.update('nerv-code.permissionMode', nextMode);
    this.appendActivity('info', `Permission mode changed to "${nextMode}". Restarting session...`);
    this.setInteractionStatus('permission', 'pending', `Switching to permission mode: ${nextMode}...`);
    this.postState();
    await this.restartSession();
    this.clearInteractionStatus('permission');
    this.setInteractionStatus('permission', 'success', `Permission mode: ${nextMode}`);
    this.postState();
  }

  async handleIdeContextToggle(enabled) {
    this.ideContextEnabled = Boolean(enabled);
    this.applyInteractionStateToState();
    await this.context.workspaceState.update('nerv-code.ideContextEnabled', this.ideContextEnabled);
    this.appendActivity(
      'info',
      `IDE context ${this.ideContextEnabled ? 'enabled' : 'disabled'} for new prompts.`,
    );
    this.setInteractionStatus(
      'ideContext',
      'success',
      `IDE context ${this.ideContextEnabled ? 'enabled' : 'disabled'}.`,
    );
    this.postState();
  }

  async handlePlanModeToggle(enabled) {
    const nextValue = Boolean(enabled);
    if (nextValue === this.planModeEnabled) {
      return;
    }

    this.planModeEnabled = nextValue;
    this.applyInteractionStateToState();
    this.setInteractionStatus('plan', 'success', `Plan mode ${nextValue ? 'enabled' : 'disabled'}.`);
    this.postState();

    if (nextValue) {
      this.appendActivity('info', 'Plan mode requested. Sending /plan to MAGI.');
      await this.sendPrompt('/plan', {
        raw: true,
        appendToTranscript: false,
      });
      return;
    }

    this.appendActivity('info', 'Plan mode exit requested.');
    await this.sendPrompt(
      'Exit plan mode. If you are currently in plan mode, use ExitPlanMode and return to implementation mode.',
      {
        raw: true,
        appendToTranscript: false,
      },
    );
  }

  async handleModelSelection(value) {
    const selectedValue = typeof value === 'string' && value.trim() ? value.trim() : 'default';
    const selectedProfile = this.modelProfiles.find(profile => profile.id === selectedValue);
    const targetProfileId = selectedProfile?.id || null;
    const targetEnvOverrides = { ...(selectedProfile?.env || {}) };
    const targetModel = selectedProfile?.model || selectedValue;
    const label = selectedProfile?.label || this.resolveModelOptionLabel(targetModel);
    const previousEnvSignature = JSON.stringify(this.activeEnvOverrides || {});
    const nextEnvSignature = JSON.stringify(targetEnvOverrides || {});
    const requiresRestart =
      previousEnvSignature !== nextEnvSignature ||
      !this.process ||
      this.process.exitCode != null ||
      this.process.killed;

    if (
      !this.pendingModelChange &&
      this.activeProfileId === targetProfileId &&
      this.state.selectedModel === targetModel &&
      previousEnvSignature === nextEnvSignature
    ) {
      return;
    }

    this.pendingModelChange = {
      requestedValue: selectedValue,
      label,
      targetProfileId,
      targetEnvOverrides,
      targetModel,
      requiresRestart,
      previous: {
        activeProfileId: this.activeProfileId,
        activeEnvOverrides: { ...(this.activeEnvOverrides || {}) },
        selectedModel: this.state.selectedModel,
        runtimeModel: this.state.runtime?.model || null,
      },
    };
    this.pendingModelSelection = targetModel;
    this.setInteractionStatus('model', 'pending', `Applying ${label}...`);
    if (selectedProfile?.id === 'minimax-m2-7' && Object.keys(selectedProfile.env || {}).length === 0) {
      this.appendActivity(
        'warn',
        'MiniMax preset selected. If you are not using global env vars, add ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN under nerv-code.modelProfiles[].env in settings.json.',
      );
    }
    this.postState();

    if (requiresRestart) {
      // Save conversation history for context carryover into the new session
      if (this.state.messages.length > 0) {
        this._contextCarryover = this.buildContextCarryoverSummary(this.state.messages, label);
        this._carryoverMessages = [...this.state.messages];
      }
      await this.restartSession();
      return;
    }

    if (this.state.backendStatus !== 'online') {
      this.ensureProcess();
      return;
    }

    const requestId = this.requestModelChange(targetModel, { track: true });
    if (!requestId) {
      this.failPendingModelChange(`Failed to switch model to ${label}.`, { restoreSession: false });
      this.postState();
    }
  }

  requestModelChange(modelValue, options = {}) {
    const nextModel = (typeof modelValue === 'string' && modelValue.trim() ? modelValue.trim() : 'default').replace(/\[1m\]$/i, '');
    const requestId = randomUUID();
    const sent = this.sendMessage({
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'set_model',
        model: nextModel,
      },
    });

    if (sent && options.track !== false) {
      this.pendingModelRequestId = requestId;
    }

    return sent ? requestId : null;
  }

  async restartSession() {
    const previousMessages = this.state.messages.length;
    const carryoverMessages = this._carryoverMessages || null;
    await this.stopProcess('other');
    this.state = createInitialState();
    this.clearStreamingAssistant();
    this.applyStaticConfigurationToState();
    this.planModeEnabled = false;
    this.applyInteractionStateToState();
    this.syncHistoryState();
    // Restore old messages in transcript so the user sees continuity
    if (carryoverMessages && carryoverMessages.length > 0) {
      this.state.messages = carryoverMessages.map(msg => ({
        ...msg,
        tone: msg.tone === 'operator' ? 'operator' : (msg.tone || msg.role),
      }));
      this.appendActivity('info', 'Model switched. Carrying conversation context into new session...');
    } else {
      this.appendActivity(
        'info',
        previousMessages > 0
          ? 'Session restarted. MAGI handshake reset.'
          : 'Session ready. MAGI handshake reset.',
      );
    }
    this._carryoverMessages = null;
    this.postState();
    this.ensureProcess();
  }

  /**
   * Spawn a clean CLI process to run `auth login` against Anthropic directly.
   * This does NOT touch the current model session — it opens the browser for OAuth,
   * stores the token in ~/.claude/, and reports success/failure back to the UI.
   */
  async spawnAuthLogin(method = 'claudeai') {
    const launchSpec = resolveBackendLaunchSpec();
    if (!launchSpec.exists) {
      this.appendMessage('system', 'CLI not found. Cannot start login flow.', 'system');
      this.postState();
      return;
    }

    this.appendMessage('system', 'Opening Anthropic login in your browser...', 'system');
    this.state.loginInProgress = true;
    this.postState();

    const args = [...launchSpec.args, 'auth', 'login'];
    if (method === 'console') args.push('--console');
    else args.push('--claudeai');
    const cleanEnv = { ...process.env };
    // Remove proxy overrides so the CLI talks to Anthropic directly
    delete cleanEnv.ANTHROPIC_BASE_URL;
    delete cleanEnv.ANTHROPIC_AUTH_TOKEN;
    delete cleanEnv.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST;

    const child = spawn(launchSpec.command, args, {
      cwd: getWorkingDirectory(),
      env: cleanEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    child.on('close', code => {
      this.state.loginInProgress = false;
      if (code === 0) {
        this.appendMessage('system', 'Login successful! Switching to Claude model...', 'system');
        this.appendActivity('info', 'Anthropic OAuth login completed.');
        // Auto-retry the model switch that triggered login
        const pending = this.state.pendingLoginForModel;
        this.state.pendingLoginForModel = null;
        if (pending) {
          setTimeout(() => {
            void this.handleModelSelection(pending.profileId || pending.model || 'default');
          }, 500);
        }
      } else {
        const detail = stderr.trim() || stdout.trim() || `Process exited with code ${code}`;
        this.appendMessage('system', `Login failed: ${detail}`, 'system');
        this.appendActivity('error', `Auth login failed: ${detail}`);
      }
      this.postState();
    });

    child.on('error', err => {
      this.state.loginInProgress = false;
      this.appendMessage('system', `Login process error: ${err.message}`, 'system');
      this.postState();
    });
  }

  /**
   * Cancel pending login — dismiss login screen, restore previous model profile, restart backend.
   */
  cancelPendingLogin() {
    this.state.pendingLoginForModel = null;
    this.state.lastError = null;
    this.appendActivity('info', 'Login cancelled. Restoring previous model.');
    // Restore the previous profile's process
    this.ensureProcess();
    this.postState();
  }

  dispose() {
    void this.archiveCurrentSession();
    return this.stopProcess('other');
  }

  async handleWebviewMessage(message) {
    switch (message?.type) {
      case 'ready':
        this.webviewReady = true;
        this.postState();
        this.focusInput();
        break;
      case 'stopGeneration':
        _log('handleWebviewMessage: stopGeneration');
        this.sendMessage({
          type: 'control_request',
          request_id: randomUUID(),
          request: { subtype: 'interrupt' },
        });
        this.state.busy = false;
        this.state.sessionState = 'idle';
        this.clearStreamingAssistant();
        this.appendActivity('warn', 'Generation interrupted by user.');
        this.postState();
        break;
      case 'sendPrompt':
        _log('handleWebviewMessage: sendPrompt text=' + JSON.stringify(message.text));
        {
          const _r = await this.sendPrompt(message.text, { attachments: message.attachments });
          _log('handleWebviewMessage: sendPrompt result=' + JSON.stringify(_r));
          this.view?.webview.postMessage({ type: 'promptSubmission', result: _r });
        }
        break;
      case 'toggleIdeContext':
        await this.handleIdeContextToggle(Boolean(message.enabled));
        break;
      case 'togglePlanMode':
        await this.handlePlanModeToggle(Boolean(message.enabled));
        break;
      case 'selectThinkingMode':
        await this.handleThinkingModeSelection(message.value);
        break;
      case 'selectModel':
        await this.handleModelSelection(message.value);
        break;
      case 'selectPermissionMode':
        await this.handlePermissionModeSelection(message.value);
        break;
      case 'requestUsage':
        // Usage data is tracked locally; no backend request needed
        this.postState();
        break;
      case 'login':
        await this.spawnAuthLogin(message.method || 'claudeai');
        break;
      case 'loginCancel':
        this.cancelPendingLogin();
        break;
      case 'restart':
        await this.restartSession();
        break;
      case 'newSession':
        await this.archiveCurrentSession();
        this.clearHistoryPreview();
        await this.restartSession();
        break;
      case 'permissionDecision':
        await this.respondToPermission(Boolean(message.allow));
        break;
      case 'openModelSettings':
        await vscode.commands.executeCommand('workbench.action.openSettingsJson');
        break;
      case 'openHistoryEntry':
        await this.openHistoryEntry(message.id);
        break;
      case 'restoreHistoryEntry':
        await this.restoreHistoryEntry(message.id);
        break;
      case 'clearHistoryPreview':
        this.clearHistoryPreview();
        break;
      case 'focusInputAck':
        this.pendingFocusInput = false;
        break;
      /* ── 工具精细控制消息 ── */
      case 'updateToolPermission':
        // 更新单个工具的允许/拒绝状态
        await this.updateToolPermission(message.toolName, message.allowed);
        break;
      case 'resetToolPermissions':
        // 重置所有工具权限
        await this.resetToolPermissions();
        break;
      /* ── 多会话并行消息 ── */
      case 'addParallelSession':
        // 创建新的并行会话
        await this.addParallelSession();
        break;
      case 'switchSession':
        // 切换到指定会话
        await this.switchSession(message.id);
        break;
      case 'closeSession':
        // 关闭指定会话
        await this.closeSession(message.id);
        break;
      default:
        break;
    }
  }

  focusInput() {
    if (!this.view || !this.webviewReady || !this.pendingFocusInput) {
      return;
    }
    this.view.webview.postMessage({ type: 'focusInput' });
    this.pendingFocusInput = false;
  }

  ensureProcess() {
    if (this.process && this.process.exitCode == null && !this.process.killed) {
      _log('ensureProcess: already alive pid=' + this.process.pid);
      return;
    }
    _log('ensureProcess: no alive process');

    const launchSpec = resolveBackendLaunchSpec();
    _log('ensureProcess: launchSpec=' + JSON.stringify({ type: launchSpec.type, exists: launchSpec.exists, label: launchSpec.label, command: launchSpec.command, args: launchSpec.args }));
    if (!launchSpec.exists) {
      const message = `Configured NERV CLI not found at ${launchSpec.label}`;
      _log('ensureProcess: NOT FOUND: ' + message);
      this.state.backendStatus = 'error';
      this.state.lastError = message;
      this.appendActivity(
        'error',
        `${message}. Update nerv-code.cliPath or install the nerv command on PATH.`,
      );
      this.postState();
      return;
    }

    _log('ensureProcess: calling startProcess');
    this.startProcess(launchSpec);
  }

  startProcess(launchSpec) {
    const cwd = getWorkingDirectory();
    const args = [
      ...launchSpec.args,
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--permission-mode',
      this.permissionMode || 'default',
      '--permission-prompt-tool',
      'stdio',
    ];

    // Pass --thinking flag to CLI to set correct context window (prevents 1M default)
    const thinkingMode = sanitizeThinkingMode(this.thinkingMode);
    if (thinkingMode === 'off') {
      args.push('--thinking', 'disabled');
    } else if (thinkingMode === 'adaptive') {
      args.push('--thinking', 'adaptive');
    } else {
      // low/medium/high → pass as max-thinking-tokens budget
      const budget = this.getThinkingBudget(thinkingMode);
      if (budget != null) {
        args.push('--max-thinking-tokens', budget.toString());
      }
    }

    // Pass --model flag if a model is selected (strip [1m] suffix to avoid 1M context)
    const profile = this.getSelectedProfile();
    const rawModelName = this.pendingModelChange?.targetModel || profile?.model;
    const modelName = rawModelName ? rawModelName.replace(/\[1m\]$/i, '') : null;
    if (modelName && modelName !== 'default') {
      args.push('--model', modelName);
    }

    _log('startProcess: cmd=' + launchSpec.command + ' args=' + JSON.stringify(args) + ' cwd=' + cwd);

    this.isStopping = false;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.state.cwd = normalizePath(cwd);
    this.state.backendStatus = 'starting';
    this.state.sessionState = 'idle';
    this.state.busy = false;
    this.state.pendingPermission = null;
    this.state.lastError = null;
    this.clearStreamingAssistant();
    this.refreshIdeContext();
    this.lastLaunchSpec = launchSpec;

    const child = spawn(launchSpec.command, args, {
      cwd,
      env: this.buildSpawnEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process = child;
    _log('startProcess: spawned pid=' + child.pid);
    if (this.pendingModelChange?.targetModel) {
      this.pendingModelSelection = this.pendingModelChange.targetModel;
    } else if (this.getSelectedProfile()) {
      this.pendingModelSelection = this.getSelectedProfile()?.model || 'default';
    }
    this.appendActivity(
      'info',
      `MAGI link established in ${normalizePath(cwd)} via ${launchSpec.label}.`,
    );

    child.stdout.on('data', chunk => {
      const s = chunk.toString();
      _log('stdout(' + s.length + '): ' + s.slice(0, 300));
      this.handleStdout(s);
    });

    child.stderr.on('data', chunk => {
      _log('stderr: ' + chunk.toString().slice(0, 500));
      this.handleStderr(chunk.toString());
    });

    child.on('error', error => {
      _log('child ERROR: ' + (error?.message || error) + ' code=' + error?.code);
      const detail = formatLaunchError(error, this.lastLaunchSpec);
      this.state.backendStatus = 'error';
      this.state.lastError = detail;
      this.appendActivity('error', `Backend launch failed: ${detail}`);
      if (this.pendingModelChange) {
        this.failPendingModelChange(`Failed to launch backend: ${detail}`);
      }
      if (this.pendingThinkingChange) {
        this.failPendingThinkingChange(`Failed to launch backend: ${detail}`);
      }
      this.postState();
    });

    child.on('close', (code, signal) => {
      _log('child CLOSE: code=' + code + ' signal=' + signal);
      const expectedStop = this.isStopping;
      this.process = null;
      this.stdoutBuffer = '';
      this.stderrBuffer = '';
      this.state.busy = false;
      this.state.pendingPermission = null;
      this.clearStreamingAssistant();

      if (expectedStop) {
        this.state.backendStatus = 'idle';
      } else if (code === 0) {
        this.state.backendStatus = 'closed';
        this.appendActivity('warn', 'MAGI backend closed. Use Restart Session to reconnect.');
      } else {
        this.state.backendStatus = 'error';
        const detail = `MAGI backend exited with code ${code}${signal ? ` (${signal})` : ''}`;
        this.state.lastError = detail;
        this.appendActivity('error', detail);
        if (this.pendingModelChange) {
          this.failPendingModelChange(detail);
        }
        if (this.pendingThinkingChange) {
          this.failPendingThinkingChange(detail);
        }
      }

      this.isStopping = false;
      this.postState();
    });

    this.sendInitialize();
  }

  async stopProcess(reason) {
    if (!this.process) {
      return;
    }

    const child = this.process;
    this.isStopping = true;

    await new Promise(resolve => {
      let finished = false;
      const complete = () => {
        if (finished) {
          return;
        }
        finished = true;
        resolve();
      };

      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch (_error) {
          // Ignore forced shutdown failures.
        }
        complete();
      }, 1200);

      child.once('close', () => {
        clearTimeout(timer);
        complete();
      });

      try {
        child.stdin.write(
          JSON.stringify({
            type: 'control_request',
            request_id: randomUUID(),
            request: {
              subtype: 'end_session',
              reason: reason || 'other',
            },
          }) + '\n',
        );
        child.stdin.end();
      } catch (_error) {
        clearTimeout(timer);
        try {
          child.kill();
        } catch (_killError) {
          // Ignore kill failures during shutdown.
        }
        complete();
      }
    });
  }

  sendInitialize() {
    this.sendMessage({
      type: 'control_request',
      request_id: randomUUID(),
      request: {
        subtype: 'initialize',
        promptSuggestions: false,
        agentProgressSummaries: true,
      },
    });
  }

  async sendPrompt(text, options = {}) {
    console.log('[NERV-DEBUG] sendPrompt called, text:', text);
    const prompt = typeof text === 'string' ? text.trim() : '';
    if (!prompt) {
      console.log('[NERV-DEBUG] prompt is empty');
      return buildPromptSubmissionResult(false, 'Prompt is empty.');
    }

    if (this.state.busy || this.state.pendingPermission) {
      console.log('[NERV-DEBUG] blocked: busy=', this.state.busy, 'pending=', this.state.pendingPermission);
      this.appendActivity('warn', 'MAGI is still processing the previous turn.');
      this.postState();
      return buildPromptSubmissionResult(false, 'MAGI is still processing the previous turn.');
    }

    this.refreshIdeContext();
    console.log('[NERV-DEBUG] before ensureProcess, process exists:', !!this.process);
    this.ensureProcess();
    console.log('[NERV-DEBUG] after ensureProcess, process exists:', !!this.process, 'backendStatus:', this.state.backendStatus, 'lastError:', this.state.lastError);
    if (!this.process) {
      console.log('[NERV-DEBUG] no process, returning not ready');
      return buildPromptSubmissionResult(false, 'MAGI backend is not ready yet.');
    }

    // Prepend context carryover from model switch (if any) to the first user message
    let effectivePrompt = prompt;
    if (this._contextCarryover && options.raw !== true) {
      effectivePrompt = this._contextCarryover + '\n\n---\n\n[User continues]:\n' + prompt;
      this._contextCarryover = null;
      this.appendActivity('info', 'Previous conversation context attached to this message.');
    }

    if (options.appendToTranscript !== false) {
      this.appendMessage('user', options.displayText || prompt, 'operator');
    }
    this.clearStreamingAssistant();
    this.state.busy = true;
    this.state.sessionState = 'running';
    this.state.lastError = null;
    this.postState();

    // Build content: string for plain text, array for text + attachments
    // Uses universally compatible formats so ANY model can process them:
    //   - Images  → 'image' block with base64 (supported by all vision models)
    //   - Text/code files → inlined as 'text' block (works with every LLM)
    //   - PDFs → inlined as 'text' block with base64 fallback hint
    let content;
    const textContent = options.raw ? effectivePrompt : this.buildPromptWithIdeContext(effectivePrompt);
    const attachments = Array.isArray(options.attachments) ? options.attachments : [];

    console.log('[NERV-DEBUG] attachments count:', attachments.length, 'types:', attachments.map(a => a.type));
    if (attachments.length > 0) {
      content = [{ type: 'text', text: textContent }];
      for (const att of attachments) {
        if (att.type === 'image') {
          // Image blocks are universally supported by vision-capable models
          console.log('[NERV-DEBUG] adding image block, mediaType:', att.mediaType, 'data length:', att.data?.length);
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: att.mediaType, data: att.data },
          });
        } else if (att.type === 'document') {
          // Inline all document content as text blocks for universal model compatibility.
          // The 'document' block type is Anthropic-only; text blocks work everywhere.
          const decoded = Buffer.from(att.data, 'base64').toString('utf-8');
          if (att.mediaType === 'application/pdf') {
            // PDF: extract text so ANY model can read the content, then also
            // include the raw document block for Claude (native PDF support).
            const pdfBuf = Buffer.from(att.data, 'base64');
            const extractedText = extractPdfText(pdfBuf);
            if (extractedText) {
              content.push({
                type: 'text',
                text: `── PDF: ${att.name} (extracted text) ──\n${extractedText}\n── End of ${att.name} ──`,
              });
            } else {
              content.push({
                type: 'text',
                text: `[Attached PDF: ${att.name} — text extraction failed, this may be a scanned/image-based PDF]`,
              });
            }
            // Also send the raw document block for models with native PDF support
            content.push({
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: att.data },
              title: att.name,
            });
          } else {
            // Text / code file: inline the full content as a text block
            content.push({
              type: 'text',
              text: `── File: ${att.name} ──\n${decoded}\n── End of ${att.name} ──`,
            });
          }
        }
      }
    } else {
      content = textContent;
    }

    const message = {
      type: 'user',
      message: {
        role: 'user',
        content,
      },
      parent_tool_use_id: null,
      session_id: this.state.sessionId || '',
      uuid: randomUUID(),
    };

    // Debug: log content structure (not actual data to avoid spamming)
    if (Array.isArray(content)) {
      console.log('[NERV-DEBUG] sending content blocks:', content.map(b => ({
        type: b.type,
        ...(b.type === 'image' ? { source_type: b.source?.type, media_type: b.source?.media_type, data_len: b.source?.data?.length } : {}),
        ...(b.type === 'text' ? { text_len: b.text?.length } : {}),
      })));
    } else {
      console.log('[NERV-DEBUG] sending plain text, length:', content?.length);
    }

    const sent = this.sendMessage(message);
    if (!sent) {
      this.state.busy = false;
      this.state.sessionState = 'idle';
      this.state.lastError = 'Failed to deliver prompt to backend.';
      this.appendActivity('error', 'Failed to deliver prompt to MAGI backend.');
      this.postState();
      return buildPromptSubmissionResult(false, 'Failed to deliver prompt to MAGI backend.');
    }

    return buildPromptSubmissionResult(true);
  }

  /**
   * Show a diff view for a proposed file edit.
   * Called when an Edit/Write tool permission request arrives.
   */
  async showProposedDiff(filePath, original, proposed, requestId) {
    const leftUri = vscode.Uri.parse(`${DIFF_SCHEME_LEFT}:${filePath}`);
    const rightUri = vscode.Uri.parse(`${DIFF_SCHEME_RIGHT}:${filePath}`);
    diffProviderLeft.setContent(leftUri, original);
    diffProviderRight.setContent(rightUri, proposed);
    activeDiffInfo = { filePath, requestId, original, proposed };
    await vscode.commands.executeCommand('setContext', 'nerv-code.viewingProposedDiff', true);
    const title = `${path.basename(filePath)} (NERV Proposed Changes)`;
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
  }

  async respondToPermission(allowOrRequestId, allowValue) {
    // Support two call signatures:
    //   respondToPermission(true/false) — use current pendingPermission
    //   respondToPermission(requestId, true/false) — use specific requestId
    let pending;
    let allow;
    if (typeof allowOrRequestId === 'string') {
      // Called from diff accept/reject with a specific requestId
      allow = Boolean(allowValue);
      pending = this.state.pendingPermission?.requestId === allowOrRequestId
        ? this.state.pendingPermission
        : { requestId: allowOrRequestId, toolName: 'Edit', toolUseId: null, input: {} };
    } else {
      allow = Boolean(allowOrRequestId);
      pending = this.state.pendingPermission;
    }
    if (!pending) {
      return;
    }

    const response = allow
      ? {
          behavior: 'allow',
          updatedInput: pending.input || {},
          toolUseID: pending.toolUseId,
          decisionClassification: 'user_temporary',
        }
      : {
          behavior: 'deny',
          message: 'Operator denied the request in VS Code.',
          toolUseID: pending.toolUseId,
          decisionClassification: 'user_reject',
        };

    this.sendMessage({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: pending.requestId,
        response,
      },
    });

    this.appendActivity(
      allow ? 'info' : 'warn',
      `${allow ? 'Approved' : 'Denied'} ${pending.toolName} request.`,
    );

    this.state.pendingPermission = null;
    this.state.sessionState = allow ? 'running' : 'idle';
    this.state.busy = allow;
    this.postState();

  }

  sendMessage(payload) {
    if (!this.process || this.process.exitCode != null || this.process.killed) {
      return false;
    }

    try {
      this.process.stdin.write(JSON.stringify(payload) + '\n');
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.state.backendStatus = 'error';
      this.state.lastError = detail;
      this.appendActivity('error', `Failed to write to backend: ${detail}`);
      this.postState();
      return false;
    }
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      this.handleLine(trimmed);
    }

    // Safety: if buffer holds a complete JSON object without trailing newline
    // (common for the final "result" message), flush it immediately
    if (this.stdoutBuffer.length > 0) {
      const buf = this.stdoutBuffer.trim();
      if (buf.startsWith('{') && buf.endsWith('}')) {
        this.stdoutBuffer = '';
        this.handleLine(buf);
      }
    }
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.appendActivity('error', `Malformed backend event: ${detail}`);
      this.postState();
      return;
    }

    if (message && typeof message.session_id === 'string' && message.session_id) {
      this.state.sessionId = message.session_id;
    }

    switch (message?.type) {
      case 'control_response':
        this.handleControlResponse(message);
        break;
      case 'control_request':
        this.handleControlRequest(message);
        break;
      case 'system':
        this.handleSystemMessage(message);
        break;
      case 'assistant':
        this.handleAssistantMessage(message);
        break;
      case 'result':
        this.handleResult(message);
        break;
      case 'rate_limit_event':
        this.handleRateLimitEvent(message);
        break;
      case 'tool_use_summary':
        this.appendActivity('info', message.summary || 'Tool activity completed.');
        // 检测 Agent 子代理工具使用并追踪
        if (message.tool_name === 'Agent' || (message.summary && message.summary.includes('agent'))) {
          this.trackAgent({
            id: message.tool_use_id || randomUUID(),
            description: message.summary || 'Agent sub-process',
            status: 'completed',
            duration: message.duration_ms ? `${message.duration_ms}ms` : null,
          });
        }
        break;
      case 'auth_status':
        this.handleAuthStatus(message);
        break;
      case 'stream_event':
        this.handleStreamEvent(message);
        break;
      default:
        this.appendActivity('warn', `Unhandled backend event: ${message?.type || 'unknown'}`);
        break;
    }

    this.postState();
  }

  handleControlResponse(message) {
    const requestId = message?.response?.request_id || message?.request_id || null;
    console.log('[NERV-DEBUG] handleControlResponse requestId:', requestId,
      'pendingModelRequestId:', this.pendingModelRequestId,
      'pendingModelSelection:', this.pendingModelSelection,
      'subtype:', message?.response?.subtype,
      'hasAccount:', Boolean(message?.response?.response?.account));
    if (message?.response?.subtype !== 'success') {
      const detail = message?.response?.error || 'Backend control request failed.';
      this.state.lastError = detail;
      if (requestId && requestId === this.pendingModelRequestId) {
        this.failPendingModelChange(detail, { restoreSession: false });
        return;
      }
      if (requestId && requestId === this.pendingThinkingRequestId) {
        this.failPendingThinkingChange(detail);
        return;
      }
      this.appendActivity('error', detail);
      return;
    }

    if (requestId && requestId === this.pendingModelRequestId) {
      this.commitPendingModelChange();
      return;
    }

    if (requestId && requestId === this.pendingThinkingRequestId) {
      this.commitPendingThinkingChange();
      return;
    }

    const response = message.response.response;
    if (response?.account || response?.models || response?.commands) {
      this.state.backendStatus = 'online';
      this.state.account = response.account || this.state.account;
      this.state.availableModels = Array.isArray(response.models)
        ? filterExtendedContextModels(response.models.map(normalizeModelInfo))
        : getBuiltinFallbackModels();
      _log('availableModels: ' + JSON.stringify(this.state.availableModels.map(m => m.value)));
      this.appendActivity(
        'info',
        `MAGI online${response.account?.subscriptionType ? ` - ${response.account.subscriptionType}` : ''}.`,
      );

      if (this.pendingModelSelection) {
        const requestedModel = this.pendingModelSelection;
        this.pendingModelSelection = null;
        const shouldTrack = Boolean(this.pendingModelChange);
        const request = this.requestModelChange(requestedModel, { track: shouldTrack });
        if (!request && this.pendingModelChange) {
          this.failPendingModelChange(`Failed to switch model to ${this.pendingModelChange.label}.`);
        }
      }

      if (this.pendingThinkingMode !== null) {
        const requestedThinkingMode = this.pendingThinkingMode;
        this.pendingThinkingMode = null;
        const request = this.requestThinkingMode(requestedThinkingMode, {
          track: Boolean(this.pendingThinkingChange),
        });
        if (!request && this.pendingThinkingChange) {
          this.failPendingThinkingChange('Failed to apply thinking mode.');
        }
      } else if (this.thinkingMode !== 'adaptive') {
        this.requestThinkingMode(this.thinkingMode, { track: false });
      }
    }
  }

  handleControlRequest(message) {
    if (message?.request?.subtype !== 'can_use_tool') {
      this.appendActivity(
        'warn',
        `Unsupported control request: ${message?.request?.subtype || 'unknown'}`,
      );
      return;
    }

    this.state.pendingPermission = {
      requestId: message.request_id,
      toolName: message.request.tool_name,
      toolUseId: message.request.tool_use_id,
      title:
        message.request.title ||
        message.request.display_name ||
        `Authorization required for ${message.request.tool_name}`,
      description:
        message.request.description ||
        `MAGI requests approval to use ${message.request.tool_name}.`,
      input: message.request.input || {},
    };
    this.state.sessionState = 'requires_action';
    this.state.busy = true;
    this.appendActivity('warn', `Authorization required for ${message.request.tool_name}.`);

    // Embed diff data into pendingPermission for inline display in the sidebar
    const toolName = message.request.tool_name;
    const input = message.request.input || {};
    if ((toolName === 'Edit' || toolName === 'Write') && input.file_path) {
      try {
        const original = toolName === 'Edit' && fs.existsSync(input.file_path)
          ? fs.readFileSync(input.file_path, 'utf-8')
          : '';
        let proposed = original;
        if (toolName === 'Edit' && input.old_string != null && input.new_string != null) {
          proposed = original.replace(input.old_string, input.new_string);
        } else if (toolName === 'Write' && input.content != null) {
          proposed = input.content;
        }
        if (proposed !== original) {
          this.state.pendingPermission.diff = {
            filePath: input.file_path,
            original,
            proposed,
          };
        }
      } catch (err) {
        _log('diff generation error: ' + err.message);
      }
    }
    this.postState();
  }

  handleSystemMessage(message) {
    switch (message.subtype) {
      case 'init':
        this.state.backendStatus = 'online';
        this.state.runtime = summarizeRuntime(message);
        if (this.modelProfiles.length === 0 && this.state.runtime?.model) {
          this.state.selectedModel = this.state.runtime.model;
        }
        break;
      case 'session_state_changed':
        this.state.sessionState = message.state;
        this.state.busy = message.state !== 'idle';
        if (message.state === 'idle') {
          this.state.pendingPermission = null;
          this.clearStreamingAssistant();
        }
        break;
      case 'task_started':
        // 任务开始 —— 添加到任务列表并记录日志
        this.appendActivity('info', `Task started: ${message.description}`);
        this.addTodo({
          id: message.task_id || randomUUID(),
          content: message.description || 'Task',
          activeForm: message.description || 'Running task',
          status: 'in_progress',
          startedAt: new Date().toISOString(),
        });
        break;
      case 'task_progress':
        // 任务进度更新
        this.appendActivity('info', message.summary || message.description || 'Task is running.');
        if (message.task_id) {
          this.updateTodo(message.task_id, {
            activeForm: message.summary || message.description || 'Running task',
          });
        }
        break;
      case 'task_notification':
        // 任务完成/失败通知
        this.appendActivity(
          message.status === 'failed' ? 'error' : 'info',
          message.summary || `Task ${message.status}.`,
        );
        if (message.task_id) {
          this.updateTodo(message.task_id, {
            status: message.status === 'failed' ? 'error' : 'completed',
          });
        }
        break;
      case 'post_turn_summary':
        if (message.is_noteworthy) {
          this.appendActivity('info', `${message.title} - ${message.status_detail}`);
        }
        break;
      case 'local_command_output':
        this.appendMessage('assistant', message.content || '', 'system');
        break;
      case 'api_retry':
        this.appendActivity(
          'warn',
          `API retry ${message.attempt}/${message.max_retries} after ${message.retry_delay_ms} ms.`,
        );
        break;
      case 'hook_started':
        // Hook 开始执行 —— 记录到 hooks 日志和操作日志
        this.appendHook({
          id: message.hook_id || randomUUID(),
          name: message.hook_name || message.hook || 'Hook',
          type: message.hook_type || 'unknown',
          status: 'running',
          startedAt: new Date().toISOString(),
        });
        this.appendActivity('info', `Hook started: ${message.hook_name || message.hook || 'Hook'}`);
        break;
      case 'hook_progress':
        // Hook 进度更新
        if (message.hook_id) {
          this.updateHook(message.hook_id, { output: message.output || message.content });
        }
        break;
      case 'hook_response':
        // Hook 执行完成
        if (message.hook_id) {
          this.updateHook(message.hook_id, {
            status: message.error ? 'error' : 'completed',
            output: message.output || message.content,
          });
        }
        this.appendActivity(
          message.error ? 'warn' : 'info',
          `Hook ${message.error ? 'failed' : 'completed'}: ${message.hook_name || message.hook || 'Hook'}`,
        );
        break;
      default:
        break;
    }
  }

  handleAssistantMessage(message) {
    const text = extractAssistantText(message.message);
    if (!text) {
      if (message.error) {
        this.clearStreamingAssistant();
        this.appendMessage(
          'assistant',
          `MAGI returned ${message.error}. No text content was emitted.`,
          'error',
        );
      }
      return;
    }

    this.clearStreamingAssistant();
    this.appendMessage('assistant', text, message.error ? 'error' : 'assistant');
  }

  /**
   * 处理流式事件
   * 支持 text_delta（正文）和 thinking_delta（思考过程）
   */
  handleStreamEvent(message) {
    if (!message?.event || typeof message.event !== 'object') {
      return;
    }

    if (message.event.type === 'message_start') {
      this.clearStreamingAssistant();
      this.streamingThinkingText = '';  // 重置思考文本
      return;
    }

    // content_block_start: 检测 thinking 块的开始
    if (message.event.type === 'content_block_start') {
      if (message.event.content_block?.type === 'thinking') {
        // 标记当前块为 thinking 类型
        this.streamingBlockTypes = this.streamingBlockTypes || {};
        this.streamingBlockTypes[message.event.index] = 'thinking';
      }
      return;
    }

    if (message.event.type === 'content_block_delta') {
      const delta = message.event.delta;
      // 处理正文文本增量
      if (delta?.type === 'text_delta') {
        this.updateStreamingAssistant(message.event.index, delta.text || '');
      }
      // 处理思考过程增量
      if (delta?.type === 'thinking_delta') {
        this.streamingThinkingText = (this.streamingThinkingText || '') + (delta.thinking || '');
        this.state.streamingThinkingText = this.streamingThinkingText;
        // thinking_delta 可能在 text_delta 之前到达，需要单独推送状态
        this.postState();
      }
    }
  }

  handleRateLimitEvent(message) {
    this.state.rateLimit = message.rate_limit_info || null;
    const summary = formatRateLimitSummary(this.state.rateLimit);
    if (summary) {
      this.appendActivity(
        this.state.rateLimit?.status === 'rejected' ? 'warn' : 'info',
        `${summary}${this.state.rateLimit?.rateLimitType ? ` - ${this.state.rateLimit.rateLimitType}` : ''}.`,
      );
    }
  }

  handleAuthStatus(message) {
    if (message.error) {
      this.appendActivity('error', message.error);
      this.postState();
      return;
    }
    if (Array.isArray(message.output) && message.output.length > 0) {
      this.appendActivity('info', message.output.join(' '));
      this.postState();
    }
  }

  handleResult(message) {
    this.state.lastResult = {
      subtype: message.subtype,
      isError: Boolean(message.is_error),
      durationMs: message.duration_ms,
      durationApiMs: message.duration_api_ms,
      numTurns: message.num_turns,
      totalCostUsd: message.total_cost_usd,
    };

    // Accumulate usage history
    const turnCost = typeof message.total_cost_usd === 'number' ? message.total_cost_usd : 0;
    const turnDuration = typeof message.duration_ms === 'number' ? message.duration_ms : 0;
    const turnApiDuration = typeof message.duration_api_ms === 'number' ? message.duration_api_ms : 0;
    this.state.usageHistory.push({
      turnIndex: this.state.usageHistory.length + 1,
      cost: turnCost,
      durationMs: turnDuration,
      durationApiMs: turnApiDuration,
      timestamp: new Date().toISOString(),
      isError: Boolean(message.is_error),
    });
    this.state.totalCostUsd += turnCost;
    this.state.totalTurns = this.state.usageHistory.length;

    if (message.subtype !== 'success') {
      const detail =
        Array.isArray(message.errors) && message.errors.length > 0
          ? message.errors.join('\n')
          : `MAGI finished with ${message.subtype}.`;
      this.state.lastError = detail;
      this.clearStreamingAssistant();
      this.appendActivity('error', detail);
      this.state.busy = false;
      this.state.sessionState = 'idle';
      this.postState();
      return;
    }

    if (message.is_error && typeof message.result === 'string' && message.result.trim()) {
      const last = this.state.messages[this.state.messages.length - 1];
      if (!last || last.text !== message.result.trim()) {
        this.appendMessage('assistant', message.result.trim(), 'error');
      }
    }

    const duration = typeof message.duration_ms === 'number' ? `${message.duration_ms} ms` : 'completed';
    this.appendActivity(
      message.is_error ? 'warn' : 'info',
      `Turn ${message.is_error ? 'completed with warnings' : 'completed'} - ${duration}.`,
    );
    this.clearStreamingAssistant();
    this.state.busy = false;
    this.state.sessionState = 'idle';
    this.postState();
  }

  handleStderr(chunk) {
    this.stderrBuffer += chunk;
    const lines = this.stderrBuffer.split(/\r?\n/);
    this.stderrBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      this.state.stderr.push(trimmed);
      if (this.state.stderr.length > 40) {
        this.state.stderr = this.state.stderr.slice(-40);
      }
      this.state.lastError = trimmed;
      this.appendActivity('error', trimmed);
    }

    this.postState();
  }

  buildContextCarryoverSummary(messages, newModelLabel) {
    const lines = [];
    const limit = 40; // max messages to include
    const recent = messages.slice(-limit);
    for (const msg of recent) {
      const speaker = msg.role === 'user' ? 'User' : 'Assistant';
      const text = (msg.text || '').trim();
      if (text) {
        // Truncate very long messages
        const truncated = text.length > 1200 ? text.slice(0, 1200) + '\n... [truncated]' : text;
        lines.push(`[${speaker}]:\n${truncated}`);
      }
    }
    return (
      `[System: The user switched models to ${newModelLabel}. Below is the conversation history from the previous session. ` +
      `Continue the conversation naturally, maintaining full context of what was discussed and any tasks in progress.]\n\n` +
      lines.join('\n\n')
    );
  }

  appendMessage(role, text, tone) {
    const value = typeof text === 'string' ? text.trim() : '';
    if (!value) {
      return;
    }

    this.state.messages.push({
      id: randomUUID(),
      role,
      text: value,
      tone: tone || role,
      timestamp: new Date().toISOString(),
    });

    if (this.state.messages.length > 120) {
      this.state.messages = this.state.messages.slice(-120);
    }
  }

  appendActivity(level, text) {
    if (!text) {
      return;
    }

    this.state.activity.unshift({
      id: randomUUID(),
      level,
      text,
      timestamp: new Date().toISOString(),
    });

    if (this.state.activity.length > 60) {
      this.state.activity = this.state.activity.slice(0, 60);
    }
  }

  /* ──────────────────────────────────────────────────────────
   * Todo / 任务管理方法
   * 追踪后端报告的任务进度，供 webview 渲染任务面板
   * ────────────────────────────────────────────────────────── */

  /** 添加一个新任务到任务列表 */
  addTodo(todo) {
    this.todos = this.todos || [];
    // 避免重复添加
    const existing = this.todos.find(t => t.id === todo.id);
    if (existing) {
      Object.assign(existing, todo);
    } else {
      this.todos.push(todo);
    }
    // 限制最多 50 条任务
    if (this.todos.length > 50) {
      this.todos = this.todos.slice(-50);
    }
  }

  /** 更新指定任务的状态 */
  updateTodo(taskId, updates) {
    this.todos = this.todos || [];
    const todo = this.todos.find(t => t.id === taskId);
    if (todo) {
      Object.assign(todo, updates);
    }
  }

  /* ──────────────────────────────────────────────────────────
   * Hooks 事件日志方法
   * 记录 PreToolUse / PostToolUse 等钩子的执行状态
   * ────────────────────────────────────────────────────────── */

  /** 添加 Hook 事件记录 */
  appendHook(hook) {
    this.hooks = this.hooks || [];
    this.hooks.unshift(hook);
    if (this.hooks.length > 30) {
      this.hooks = this.hooks.slice(0, 30);
    }
  }

  /** 更新指定 Hook 的状态 */
  updateHook(hookId, updates) {
    this.hooks = this.hooks || [];
    const hook = this.hooks.find(h => h.id === hookId);
    if (hook) {
      Object.assign(hook, updates);
    }
  }

  /* ──────────────────────────────────────────────────────────
   * Agent 子代理追踪方法
   * 记录后端产生的子代理（Agent tool）运行状态
   * ────────────────────────────────────────────────────────── */

  /** 添加或更新子代理记录 */
  trackAgent(agentInfo) {
    this.agents = this.agents || [];
    const existing = this.agents.find(a => a.id === agentInfo.id);
    if (existing) {
      Object.assign(existing, agentInfo);
    } else {
      this.agents.push(agentInfo);
    }
    if (this.agents.length > 20) {
      this.agents = this.agents.slice(-20);
    }
  }

  /* ──────────────────────────────────────────────────────────
   * 工具精细控制方法
   * 管理工具的 allowlist / denylist
   * ────────────────────────────────────────────────────────── */

  /** 更新单个工具的允许/拒绝状态 */
  async updateToolPermission(toolName, allowed) {
    this.toolDenylist = this.toolDenylist || [];
    if (allowed) {
      // 从拒绝列表中移除
      this.toolDenylist = this.toolDenylist.filter(t => t !== toolName);
    } else {
      // 添加到拒绝列表
      if (!this.toolDenylist.includes(toolName)) {
        this.toolDenylist.push(toolName);
      }
    }
    await this.context.workspaceState.update('nerv-code.toolDenylist', this.toolDenylist);
    this.appendActivity('info', `Tool "${toolName}" ${allowed ? 'allowed' : 'denied'}.`);
    this.applyInteractionStateToState();
    this.postState();
  }

  /** 重置所有工具权限（清空拒绝列表） */
  async resetToolPermissions() {
    this.toolDenylist = [];
    await this.context.workspaceState.update('nerv-code.toolDenylist', []);
    this.appendActivity('info', 'All tool permissions reset to allowed.');
    this.applyInteractionStateToState();
    this.postState();
  }

  /* ──────────────────────────────────────────────────────────
   * 多会话并行管理方法
   * 支持同时运行多个 CLI 会话，通过标签页切换
   * ────────────────────────────────────────────────────────── */

  /** 添加新的并行会话 */
  async addParallelSession() {
    const newId = randomUUID();
    // 归档当前会话状态
    if (this.state.sessionId) {
      this.parallelSessions = this.parallelSessions || [];
      // 保存当前会话快照
      const currentSnapshot = {
        id: this.state.sessionId,
        title: this.getSessionTitle(),
        messages: [...this.state.messages],
        model: this.state.runtime?.model || this.state.selectedModel,
        createdAt: new Date().toISOString(),
      };
      // 如果当前会话不在列表中则添加
      if (!this.parallelSessions.find(s => s.id === this.state.sessionId)) {
        this.parallelSessions.push(currentSnapshot);
      }
    }
    // 创建新会话
    const newSession = {
      id: newId,
      title: `Session ${(this.parallelSessions?.length || 0) + 1}`,
      messages: [],
      model: this.state.runtime?.model || 'default',
      createdAt: new Date().toISOString(),
    };
    this.parallelSessions = this.parallelSessions || [];
    this.parallelSessions.push(newSession);
    this.activeSessionId = newId;
    // 重启进程开始新会话
    this.appendActivity('info', `Created parallel session: ${newSession.title}`);
    await this.restartSession();
  }

  /** 切换到指定的并行会话 */
  async switchSession(sessionId) {
    if (this.activeSessionId === sessionId) return;
    // 保存当前会话消息
    const currentIdx = this.parallelSessions?.findIndex(s => s.id === this.activeSessionId);
    if (currentIdx >= 0) {
      this.parallelSessions[currentIdx].messages = [...this.state.messages];
    }
    // 切换到目标会话
    const target = this.parallelSessions?.find(s => s.id === sessionId);
    if (!target) return;
    this.activeSessionId = sessionId;
    this.state.messages = target.messages || [];
    this.appendActivity('info', `Switched to session: ${target.title}`);
    await this.restartSession();
  }

  /** 关闭指定的并行会话 */
  async closeSession(sessionId) {
    this.parallelSessions = (this.parallelSessions || []).filter(s => s.id !== sessionId);
    if (this.activeSessionId === sessionId) {
      // 如果关闭的是当前活动会话，切换到第一个
      if (this.parallelSessions.length > 0) {
        await this.switchSession(this.parallelSessions[0].id);
      } else {
        this.activeSessionId = null;
        await this.restartSession();
      }
    }
    this.postState();
  }

  /** 获取当前会话标题（取第一条用户消息的前 20 字） */
  getSessionTitle() {
    const firstUserMsg = this.state.messages.find(m => m.role === 'user');
    if (firstUserMsg) {
      const text = firstUserMsg.text || '';
      return text.length > 20 ? text.slice(0, 20) + '...' : text;
    }
    return 'New Session';
  }

  postState() {
    this.applyInteractionStateToState();
    this.syncTransientStateToState();

    if (this.view) {
      this.view.description = this.getViewDescription();
    }

    if (!this.view || !this.webviewReady) {
      return;
    }

    this.view.webview.postMessage({
      type: 'state',
      state: this.state,
    });
  }

  getViewDescription() {
    if (this.state.pendingPermission) {
      return 'Awaiting approval';
    }
    if (this.state.backendStatus === 'starting') {
      return 'Booting';
    }
    if (this.state.sessionState === 'running') {
      return 'Running';
    }
    if (this.state.rateLimit?.status === 'rejected') {
      return 'Rate limited';
    }
    if (this.state.backendStatus === 'online') {
      return 'Online';
    }
    if (this.state.backendStatus === 'error') {
      return 'Error';
    }
    return '';
  }

  getHtml(webview) {
    const stylesUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'styles.css'),
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'app.js'),
    );
    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'nerv-marketplace-icon.png'),
    );
    const nonce = randomUUID().replace(/-/g, '');
    const initialModels =
      this.state.availableModels.length > 0 ? this.state.availableModels : getBuiltinFallbackModels();
    const initialModelOptionsMarkup = buildModelSelectMarkup(
      this.state.modelProfiles,
      initialModels,
      this.state.defaultProfileId,
    );

    return /* html */ `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} data: https:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${stylesUri}" />
    <title>${VIEW_TITLE}</title>
  </head>
  <body>
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark">NERV CODE</span>
          <span class="brand-sub">MAGI Sidecar Interface</span>
        </div>
        <div class="toolbar-actions">
          <button class="icon-button" id="historyButton" type="button" title="Session history" aria-label="Session history">&#8634;</button>
          <button class="icon-button" id="openSettingsButton" type="button" title="Settings" aria-label="Settings">&#9881;</button>
          <button class="icon-button" id="newSessionButton" type="button" title="New conversation" aria-label="New conversation">+</button>
        </div>
      </header>

      <section class="history-drawer hidden" id="historyDrawer">
        <div class="history-header">
          <strong>Previous Sessions</strong>
          <button class="ghost ghost--small" id="closeHistoryButton" type="button">Hide</button>
        </div>
        <div class="history-layout">
          <div class="history-list" id="historyList"></div>
          <div class="history-preview" id="historyPreview"></div>
        </div>
      </section>

      <section class="rate-limit hidden" id="rateLimit"></section>

      <section class="details-drawer hidden" id="detailsDrawer">
        <div class="details-header">
          <strong id="detailsTitle">Details</strong>
          <button class="ghost ghost--small" id="closeDetailsButton" type="button">Hide</button>
        </div>
        <div class="details-tabs" id="detailsTabs">
          <button class="chip" data-panel="context" type="button" aria-pressed="false">IDE Context</button>
          <button class="chip" data-panel="facts" type="button" aria-pressed="false">System</button>
          <button class="chip" data-panel="activity" type="button" aria-pressed="false">Log</button>
          <button class="chip" data-panel="mcp" type="button" aria-pressed="false">MCP</button>
          <button class="chip" data-panel="tools" type="button" aria-pressed="false">Tools</button>
          <button class="chip" data-panel="todos" type="button" aria-pressed="false">Tasks</button>
          <button class="chip" data-panel="usage" type="button" aria-pressed="false">Usage</button>
        </div>
        <div class="details-body">
          <div class="detail-panel hidden" id="contextPanel">
            <dl class="facts-list" id="context"></dl>
          </div>
          <div class="detail-panel hidden" id="factsPanel">
            <dl class="facts-list" id="facts"></dl>
          </div>
          <div class="detail-panel hidden" id="activityPanel">
            <div class="activity" id="activity"></div>
          </div>
          <div class="detail-panel hidden" id="mcpPanel">
            <div class="mcp-content"></div>
          </div>
          <div class="detail-panel hidden" id="toolsPanel">
            <div class="tools-content"></div>
          </div>
          <div class="detail-panel hidden" id="todosPanel">
            <div class="todos-content"></div>
          </div>
          <div class="detail-panel hidden" id="usagePanel">
            <div class="usage-content"></div>
          </div>
        </div>
      </section>

      <section class="permission-card hidden" id="permissionCard">
        <div class="permission-header">
          <span class="permission-label">Authorization Required</span>
          <strong id="permissionTitle"></strong>
        </div>
        <p id="permissionDescription"></p>
        <pre id="permissionInput"></pre>
        <div class="permission-actions">
          <button class="primary" id="approveButton" type="button">Allow Once</button>
          <button class="secondary" id="denyButton" type="button">Deny</button>
        </div>
      </section>

      <!-- 多会话标签栏 -->
      <div class="session-tabs hidden" id="sessionTabs"></div>

      <main class="conversation-shell">
        <section class="welcome-card" id="welcomeCard">
          <img src="${logoUri}" alt="NERV logo" class="welcome-logo" />
          <p class="welcome-kicker">MAGI System v2.1.88</p>
          <p class="welcome-tagline">God's in his heaven. All's right with the world.</p>
          <p class="welcome-note" id="welcomeNote">
            Ready. IDE context on.
          </p>
        </section>

        <section class="transcript" id="transcript"></section>
      </main>

      <!-- Login overlay (shown when Claude auth needed, covers everything) -->
      <div class="login-overlay hidden" id="loginScreen">
        <section class="login-screen">
          <img src="${logoUri}" alt="NERV logo" class="welcome-logo" />
          <p class="welcome-kicker">MAGI System v2.1.88</p>
          <p class="login-desc">NERV-CODE can be used with your Claude subscription or billed based on API usage through your Console account.</p>
          <p class="login-question">How do you want to log in?</p>
          <div class="login-error hidden" id="loginError"></div>
          <div class="login-methods">
            <button class="login-method-btn login-method-primary" id="loginClaudeAi" type="button">Claude.ai Subscription</button>
            <p class="login-method-note">Use your Claude Pro, Team, or Enterprise subscription</p>
            <button class="login-method-btn" id="loginConsole" type="button">Anthropic Console</button>
            <p class="login-method-note">Pay for API usage through your Console account</p>
          </div>
          <button class="login-cancel-btn" id="loginCancel" type="button">Cancel</button>
          <p class="login-footer">Third-party models (MiniMax, Kimi) do not require login.</p>
        </section>
      </div>

      <!-- Slash 命令自动补全弹出框 -->
      <div class="slash-popup hidden" id="slashPopup"></div>

      <footer class="composer">
        <div class="attachments-preview hidden" id="attachmentsPreview"></div>
        <div class="input-container">
          <button class="attach-btn" id="attachButton" title="Attach file" type="button">&#128206;</button>
          <span class="input-prefix">&gt;</span>
          <textarea
            id="promptInput"
            rows="1"
            placeholder="Ask MAGI to inspect code, explain a file, or make a change..."
          ></textarea>
          <button class="send-btn" id="sendButton" title="Send" type="button">&#8594;</button>
          <button class="stop-btn hidden" id="stopButton" title="Stop generation" type="button">&#9632; STOP</button>
        </div>

        <div class="config-row">
          <label class="chip-select chip-select--model" for="modelSelect">
            <span class="sr-only">Model</span>
            <select id="modelSelect">
              ${initialModelOptionsMarkup}
            </select>
          </label>
          <label class="chip-select chip-select--permission" for="permissionSelect">
            <span class="sr-only">Permissions</span>
            <select id="permissionSelect">
              <option value="default">Perm: Ask</option>
              <option value="acceptEdits">Perm: AcceptEdits</option>
              <option value="auto">Perm: Auto</option>
              <option value="bypassPermissions">Perm: Bypass</option>
              <option value="plan">Perm: Plan</option>
            </select>
          </label>
          <label class="chip-select chip-select--thinking" for="thinkingSelect">
            <span class="sr-only">Thinking</span>
            <select id="thinkingSelect">
              <option value="adaptive">Think Auto</option>
              <option value="off">Think Off</option>
              <option value="low">Think Low</option>
              <option value="medium">Think Med</option>
              <option value="high">Think High</option>
            </select>
          </label>
          <button class="chip" id="planModeToggleButton" type="button" aria-pressed="false">Plan</button>
          <button class="chip" id="ideContextToggleButton" type="button" aria-pressed="true">IDE Ctx</button>
          <button class="chip" id="panelToggleButton" type="button" aria-pressed="false">Panels</button>
        </div>

        <div class="status-bar">
          <span id="sessionMeta">Awaiting session</span>
          <span class="status-flag">AT-Field Active</span>
        </div>
      </footer>
    </div>

    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

/* ── Diff Review: Virtual filesystem provider for proposed changes ── */
class NervDiffContentProvider {
  constructor() {
    this._contents = new Map();
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
  }
  setContent(uri, content) {
    this._contents.set(uri.toString(), content);
    this._onDidChange.fire(uri);
  }
  provideTextDocumentContent(uri) {
    return this._contents.get(uri.toString()) || '';
  }
  clear() {
    this._contents.clear();
  }
}

const DIFF_SCHEME_LEFT = 'nerv-diff-left';
const DIFF_SCHEME_RIGHT = 'nerv-diff-right';
const diffProviderLeft = new NervDiffContentProvider();
const diffProviderRight = new NervDiffContentProvider();

let controller = null;
let editorPanel = null; // Webview panel for "Open in New Tab" mode
let activeDiffInfo = null; // { filePath, requestId, original, proposed }

function activate(context) {
  controller = new NervCodeController(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, controller, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('nerv-code.open', async () => {
      await controller.reveal();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('nerv-code.restart', async () => {
      await controller.restartSession();
      await controller.reveal();
    }),
  );

  // 热重载 webview（开发时无需重启 VS Code 即可更新 app.js/styles.css）
  context.subscriptions.push(
    vscode.commands.registerCommand('nerv-code.reloadWebview', () => {
      if (controller?.view) {
        controller.view.webview.html = controller.getHtml(controller.view.webview);
        controller.webviewReady = false;
      }
    }),
  );

  // ── Feature 1: Keybindings ──────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('nerv-code.focus', async () => {
      await controller?.reveal();
      controller?.view?.webview?.postMessage({ type: 'focusInput' });
      vscode.commands.executeCommand('setContext', 'nerv-code.inputFocused', true);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('nerv-code.blur', () => {
      vscode.commands.executeCommand('setContext', 'nerv-code.inputFocused', false);
      if (vscode.window.activeTextEditor) {
        vscode.window.showTextDocument(vscode.window.activeTextEditor.document);
      } else {
        vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('nerv-code.newConversation', async () => {
      await controller?.restartSession();
    }),
  );

  // ── Feature 2: Open in Editor Tab ────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('nerv-code.editor.open', () => {
      if (editorPanel) {
        editorPanel.reveal(vscode.ViewColumn.One);
        return;
      }
      editorPanel = vscode.window.createWebviewPanel(
        'nervCodePanel',
        'NERV CODE',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
        },
      );

      // Use a lightweight webview object adapter so getHtml works
      editorPanel.webview.html = controller.getHtml(editorPanel.webview);

      editorPanel.webview.onDidReceiveMessage(message => {
        _log('editorPanel message: type=' + message?.type);
        void controller?.handleWebviewMessage(message);
      });

      // Sync state to the panel
      const origPostState = controller.postState.bind(controller);
      const patchedPostState = function () {
        origPostState();
        if (editorPanel && controller?.state) {
          editorPanel.webview.postMessage({ type: 'state', state: controller.state });
        }
      };
      controller.postState = patchedPostState;

      editorPanel.onDidDispose(() => {
        editorPanel = null;
        // Restore original postState
        controller.postState = origPostState;
      });

      // Push initial state
      controller.postState();
    }),
  );

  // ── Feature 3: Diff Review ──────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME_LEFT, diffProviderLeft),
  );
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME_RIGHT, diffProviderRight),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('nerv-code.acceptProposedDiff', () => {
      if (!activeDiffInfo) return;
      const { filePath, proposed } = activeDiffInfo;
      // Write the proposed content to the actual file
      const fileUri = vscode.Uri.file(filePath);
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(fileUri, { overwrite: true, ignoreIfExists: true });
      vscode.workspace.applyEdit(edit).then(() => {
        fs.writeFileSync(filePath, proposed, 'utf-8');
        vscode.window.showInformationMessage(`NERV: Accepted changes to ${path.basename(filePath)}`);
      });
      // Also approve the permission in the backend if there's a pending request
      if (activeDiffInfo.requestId && controller) {
        controller.respondToPermission(activeDiffInfo.requestId, true);
      }
      vscode.commands.executeCommand('setContext', 'nerv-code.viewingProposedDiff', false);
      activeDiffInfo = null;
      // Close the diff editor
      vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('nerv-code.rejectProposedDiff', () => {
      if (!activeDiffInfo) return;
      // Reject: deny the permission in the backend
      if (activeDiffInfo.requestId && controller) {
        controller.respondToPermission(activeDiffInfo.requestId, false);
      }
      vscode.window.showInformationMessage(`NERV: Rejected changes to ${path.basename(activeDiffInfo.filePath)}`);
      vscode.commands.executeCommand('setContext', 'nerv-code.viewingProposedDiff', false);
      activeDiffInfo = null;
      vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }),
  );

  // Track diff editor close to reset context
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(event => {
      if (activeDiffInfo && event.closed.length > 0) {
        // Check if the diff tab was closed
        const stillOpen = vscode.window.tabGroups.all.some(group =>
          group.tabs.some(tab => tab.label?.includes('NERV Proposed'))
        );
        if (!stillOpen) {
          vscode.commands.executeCommand('setContext', 'nerv-code.viewingProposedDiff', false);
          activeDiffInfo = null;
        }
      }
    }),
  );

  // ── Feature 4: @Mention Insertion ────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('nerv-code.insertAtMention', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const doc = editor.document;
      const relPath = vscode.workspace.asRelativePath(doc.fileName);
      const sel = editor.selection;
      let mention;
      if (sel.isEmpty) {
        mention = `@${relPath}`;
      } else {
        const startLine = sel.start.line + 1;
        const endLine = sel.end.line + 1;
        mention = startLine !== endLine
          ? `@${relPath}#L${startLine}-${endLine}`
          : `@${relPath}#L${startLine}`;
      }
      // Send to webview to insert into prompt input
      await controller?.reveal();
      controller?.view?.webview?.postMessage({ type: 'insertText', text: mention });
      if (editorPanel) {
        editorPanel.webview.postMessage({ type: 'insertText', text: mention });
      }
    }),
  );

  // ── Feature 5: Create Worktree ──────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('nerv-code.createWorktree', async () => {
      const cwd = getWorkingDirectory();
      // Check if inside a git repo
      const gitCheck = require('child_process').spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf-8' });
      if (gitCheck.status !== 0) {
        vscode.window.showErrorMessage('NERV: Not inside a git repository.');
        return;
      }
      const repoRoot = path.dirname(gitCheck.stdout.trim().replace(/\\/g, '/'));
      const name = await vscode.window.showInputBox({
        prompt: 'Worktree name',
        placeHolder: 'feature-branch',
        validateInput: v => /^[a-zA-Z0-9._-]+$/.test(v) ? null : 'Alphanumeric, dots, dashes, underscores only',
      });
      if (!name) return;
      const worktreeDir = path.join(cwd, '.claude', 'worktrees', name);
      await fs.promises.mkdir(path.join(cwd, '.claude', 'worktrees'), { recursive: true });
      // Get default branch
      const branchCheck = require('child_process').spawnSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], { cwd, encoding: 'utf-8' });
      const defaultBranch = branchCheck.status === 0 ? branchCheck.stdout.trim() : 'HEAD';
      // Create worktree
      const wtResult = require('child_process').spawnSync('git', ['worktree', 'add', '-b', `worktree-${name}`, worktreeDir, defaultBranch], { cwd, encoding: 'utf-8' });
      if (wtResult.status !== 0) {
        vscode.window.showErrorMessage(`NERV: Failed to create worktree: ${wtResult.stderr || wtResult.stdout}`);
        return;
      }
      vscode.window.showInformationMessage(`NERV: Worktree created at ${worktreeDir}`);
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktreeDir), { forceNewWindow: true });
    }),
  );

  // ── Feature 6: Show Logs ────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('nerv-code.showLogs', async () => {
      const logPath = path.join(os.homedir(), 'nerv-debug.log');
      if (fs.existsSync(logPath)) {
        const doc = await vscode.workspace.openTextDocument(logPath);
        await vscode.window.showTextDocument(doc, { preview: false });
      } else {
        vscode.window.showWarningMessage('NERV: No debug log found at ' + logPath);
      }
    }),
  );

  // ── Feature 9: Reinstall / Update Extension ─────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('nerv-code.update', async () => {
      const srcDir = vscode.workspace.getConfiguration('nerv-code').get('cliPath');
      if (!srcDir) {
        vscode.window.showInformationMessage('NERV: Set nerv-code.cliPath in settings to enable update. Reinstalling from current source...');
      }
      // Copy from source to installed extension
      const extSrcBase = path.resolve(context.extensionPath, '..', '..', '..'); // Workspace likely
      const installedDir = context.extensionPath;
      const filesToCopy = ['extension.js', 'media/app.js', 'media/styles.css', 'package.json'];
      // Attempt to find source directory
      const possibleSrc = [
        'F:/AI_tool/NERV-CODE_vscode/vscode-extension',
        path.join(os.homedir(), 'NERV-CODE_vscode', 'vscode-extension'),
      ];
      let sourceDir = possibleSrc.find(d => fs.existsSync(path.join(d, 'extension.js')));
      if (!sourceDir) {
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          openLabel: 'Select NERV-CODE source directory',
        });
        if (!picked || picked.length === 0) return;
        sourceDir = picked[0].fsPath;
      }
      let copied = 0;
      for (const f of filesToCopy) {
        const src = path.join(sourceDir, f);
        const dst = path.join(installedDir, f);
        if (fs.existsSync(src)) {
          await fs.promises.mkdir(path.dirname(dst), { recursive: true });
          await fs.promises.copyFile(src, dst);
          copied++;
        }
      }
      vscode.window.showInformationMessage(`NERV: Updated ${copied} files. Reload window to apply.`);
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      controller?.refreshIdeContext();
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() => {
      controller?.refreshIdeContext();
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(event => {
      if (event.textEditor === vscode.window.activeTextEditor) {
        controller?.refreshIdeContext();
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      if (vscode.window.activeTextEditor?.document === event.document) {
        controller?.refreshIdeContext();
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      controller?.refreshIdeContext();
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (
        event.affectsConfiguration('nerv-code.modelProfiles') ||
        event.affectsConfiguration('nerv-code.defaultProfile')
      ) {
        controller?.reloadModelProfiles();
      }
    }),
  );

  context.subscriptions.push({
    dispose() {
      return controller?.dispose();
    },
  });
}

function deactivate() {
  return controller?.dispose();
}

module.exports = {
  activate,
  deactivate,
};
