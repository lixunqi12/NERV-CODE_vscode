const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

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

function sanitizeThinkingMode(value) {
  if (typeof value !== 'string') {
    return 'adaptive';
  }

  const normalized = value.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(THINKING_MODE_BUDGETS, normalized)
    ? normalized
    : 'adaptive';
}

function createInitialState() {
  return {
    cwd: normalizePath(getWorkingDirectory()),
    backendStatus: 'idle',
    sessionState: 'idle',
    busy: false,
    sessionId: null,
    runtime: null,
    account: null,
    rateLimit: null,
    pendingPermission: null,
    lastError: null,
    lastResult: null,
    messages: [],
    activity: [],
    stderr: [],
    ideContext: collectIdeContext(),
    availableModels: [],
    modelProfiles: [],
    defaultProfileId: null,
    activeProfileId: null,
    selectedModel: 'default',
    streamingAssistantText: '',
    pendingModelValue: null,
    pendingThinkingMode: null,
    interactionStatus: null,
    ideContextEnabled: true,
    planModeEnabled: false,
    thinkingMode: 'adaptive',
    sessionHistory: [],
    historyPreview: null,
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

function extractAssistantText(message) {
  if (!message || !Array.isArray(message.content)) {
    return '';
  }

  const parts = [];
  for (const block of message.content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text.trim());
    }
  }
  return parts.join('\n\n').trim();
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
    this.planModeEnabled = false;
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
    this.view = webviewView;
    this.webviewReady = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(message => {
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

  clearHistoryPreview() {
    this.historyPreviewId = null;
    this.syncHistoryState();
    this.postState();
  }

  applyInteractionStateToState() {
    this.state.ideContextEnabled = this.ideContextEnabled;
    this.state.planModeEnabled = this.planModeEnabled;
    this.state.thinkingMode = this.thinkingMode;
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
    const nextModel = typeof modelValue === 'string' && modelValue.trim() ? modelValue.trim() : 'default';
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
    await this.stopProcess('other');
    this.state = createInitialState();
    this.clearStreamingAssistant();
    this.applyStaticConfigurationToState();
    this.planModeEnabled = false;
    this.applyInteractionStateToState();
    this.syncHistoryState();
    this.appendActivity(
      'info',
      previousMessages > 0
        ? 'Session restarted. MAGI handshake reset.'
        : 'Session ready. MAGI handshake reset.',
    );
    this.postState();
    this.ensureProcess();
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
      case 'sendPrompt':
        this.view?.webview.postMessage({
          type: 'promptSubmission',
          result: await this.sendPrompt(message.text),
        });
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
      case 'clearHistoryPreview':
        this.clearHistoryPreview();
        break;
      case 'focusInputAck':
        this.pendingFocusInput = false;
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
      return;
    }

    const launchSpec = resolveBackendLaunchSpec();
    if (!launchSpec.exists) {
      const message = `Configured NERV CLI not found at ${launchSpec.label}`;
      this.state.backendStatus = 'error';
      this.state.lastError = message;
      this.appendActivity(
        'error',
        `${message}. Update nerv-code.cliPath or install the nerv command on PATH.`,
      );
      this.postState();
      return;
    }

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
    ];

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
      this.handleStdout(chunk.toString());
    });

    child.stderr.on('data', chunk => {
      this.handleStderr(chunk.toString());
    });

    child.on('error', error => {
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
    const prompt = typeof text === 'string' ? text.trim() : '';
    if (!prompt) {
      return buildPromptSubmissionResult(false, 'Prompt is empty.');
    }

    if (this.state.busy || this.state.pendingPermission) {
      this.appendActivity('warn', 'MAGI is still processing the previous turn.');
      this.postState();
      return buildPromptSubmissionResult(false, 'MAGI is still processing the previous turn.');
    }

    this.refreshIdeContext();
    this.ensureProcess();
    if (!this.process) {
      return buildPromptSubmissionResult(false, 'MAGI backend is not ready yet.');
    }

    if (options.appendToTranscript !== false) {
      this.appendMessage('user', options.displayText || prompt, 'operator');
    }
    this.clearStreamingAssistant();
    this.state.busy = true;
    this.state.sessionState = 'running';
    this.state.lastError = null;
    this.postState();

    const message = {
      type: 'user',
      message: {
        role: 'user',
        content: options.raw ? prompt : this.buildPromptWithIdeContext(prompt),
      },
      parent_tool_use_id: null,
      session_id: this.state.sessionId || '',
      uuid: randomUUID(),
    };

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

  async respondToPermission(allow) {
    const pending = this.state.pendingPermission;
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
        ? response.models.map(normalizeModelInfo)
        : getBuiltinFallbackModels();
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
        this.appendActivity('info', `Task started: ${message.description}`);
        break;
      case 'task_progress':
        this.appendActivity('info', message.summary || message.description || 'Task is running.');
        break;
      case 'task_notification':
        this.appendActivity(
          message.status === 'failed' ? 'error' : 'info',
          message.summary || `Task ${message.status}.`,
        );
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
      case 'hook_progress':
      case 'hook_response':
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

  handleStreamEvent(message) {
    if (!message?.event || typeof message.event !== 'object') {
      return;
    }

    if (message.event.type === 'message_start') {
      this.clearStreamingAssistant();
      return;
    }

    if (
      message.event.type === 'content_block_delta' &&
      message.event.delta?.type === 'text_delta'
    ) {
      this.updateStreamingAssistant(message.event.index, message.event.delta.text || '');
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
      return;
    }
    if (Array.isArray(message.output) && message.output.length > 0) {
      this.appendActivity('info', message.output.join(' '));
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

    if (message.subtype !== 'success') {
      const detail =
        Array.isArray(message.errors) && message.errors.length > 0
          ? message.errors.join('\n')
          : `MAGI finished with ${message.subtype}.`;
      this.state.lastError = detail;
      this.clearStreamingAssistant();
      this.appendActivity('error', detail);
      this.state.busy = false;
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
        <div class="topbar-spacer" aria-hidden="true"></div>
        <div class="toolbar-actions">
          <button class="icon-button" id="historyButton" type="button" title="Session history" aria-label="Session history">↺</button>
          <button class="icon-button" id="openSettingsButton" type="button" title="Settings" aria-label="Settings">⚙</button>
          <button class="icon-button" id="newSessionButton" type="button" title="New conversation" aria-label="New conversation">＋</button>
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
          <button class="chip" data-panel="facts" type="button" aria-pressed="false">System State</button>
          <button class="chip" data-panel="activity" type="button" aria-pressed="false">Operation Log</button>
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

      <main class="conversation-shell">
        <section class="welcome-card" id="welcomeCard">
          <pre class="welcome-art" aria-hidden="true">
                   ▄▄▄
                   ▄▄███████
            ▄     ▄████████   ▄
           ▀█▄    ████████▀▄███████
             ▀█▄ ▄███████████████████▄
               ▀███████████████████████
                 ▀███████████████████▀
        ███  ▀█ ███▀█████████████▀▀
        █▀██▄ █ ███▄█▀█████████▄▄
        █  ▀███ ███ ▀  ███████████▄
       ▄█▄   ▀█ ███▄▄██ ▀██████████
     █          ███▀██████▀█████████
     ▀█         ███ ███ ▀██▄▀██████▄
      ██        ██████▄   ▀███▀█████▄
       ██       ███ ▀███    ▀█  ▀███
        ▀█▄                       ██
          ▀█▄                   ▄▄█▀
            ▀▀█▄▄▄▄        ▄▄▄▀▀▀
                 ▀▀▀▀▀▀▀▀▀▀
          </pre>
          <p class="welcome-kicker">MAGI System v2.1.88</p>
          <p class="welcome-tagline">God's in his heaven. All's right with the world.</p>
          <p class="welcome-note" id="welcomeNote">
            Send a prompt below. NERV CODE automatically attaches the current editor and workspace context.
          </p>
        </section>
        <section class="transcript" id="transcript"></section>
      </main>

      <footer class="composer">
        <textarea
          id="promptInput"
          rows="2"
          placeholder="Ask MAGI to inspect code, explain a file, or make a change..."
        ></textarea>
        <div class="composer-footer">
          <div class="composer-controls">
            <div class="composer-toolbar">
              <div class="mode-strip">
                <label class="chip-select chip-select--model" for="modelSelect">
                  <span class="sr-only">Model</span>
                  <select id="modelSelect">
                    ${initialModelOptionsMarkup}
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
                <div class="mode-buttons">
                  <button class="chip" id="planModeToggleButton" type="button" aria-pressed="false">Plan Mode</button>
                  <button class="chip" id="ideContextToggleButton" type="button" aria-pressed="true">IDE Context</button>
                  <button class="chip" id="panelToggleButton" type="button" aria-pressed="false">Panels</button>
                </div>
              </div>
            </div>
            <span class="composer-hint" id="sessionMeta">Awaiting session</span>
          </div>
          <button class="primary primary--small" id="sendButton" type="button">Send</button>
        </div>
      </footer>
    </div>

    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

let controller = null;

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
