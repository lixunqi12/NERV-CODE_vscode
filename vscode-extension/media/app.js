/**
 * NERV-CODE Webview 前端脚本
 * 负责所有 UI 渲染、用户交互、消息通信
 * 与 extension.js (后端宿主) 通过 postMessage 双向通信
 */
const vscode = acquireVsCodeApi();

/* ============================================================
 * 一、DOM 元素引用
 * 在页面加载时一次性获取所有需要操作的 DOM 元素
 * ============================================================ */
const elements = {
  shell: document.querySelector('.shell'),
  composer: document.querySelector('.composer'),
  rateLimit: document.getElementById('rateLimit'),
  permissionCard: document.getElementById('permissionCard'),
  permissionTitle: document.getElementById('permissionTitle'),
  permissionDescription: document.getElementById('permissionDescription'),
  permissionInput: document.getElementById('permissionInput'),
  transcript: document.getElementById('transcript'),
  sessionMeta: document.getElementById('sessionMeta'),
  context: document.getElementById('context'),
  facts: document.getElementById('facts'),
  activity: document.getElementById('activity'),
  promptInput: document.getElementById('promptInput'),
  sendButton: document.getElementById('sendButton'),
  approveButton: document.getElementById('approveButton'),
  denyButton: document.getElementById('denyButton'),
  modelSelect: document.getElementById('modelSelect'),
  thinkingSelect: document.getElementById('thinkingSelect'),
  planModeToggleButton: document.getElementById('planModeToggleButton'),
  ideContextToggleButton: document.getElementById('ideContextToggleButton'),
  panelToggleButton: document.getElementById('panelToggleButton'),
  openSettingsButton: document.getElementById('openSettingsButton'),
  newSessionButton: document.getElementById('newSessionButton'),
  historyButton: document.getElementById('historyButton'),
  detailsDrawer: document.getElementById('detailsDrawer'),
  detailsTitle: document.getElementById('detailsTitle'),
  closeDetailsButton: document.getElementById('closeDetailsButton'),
  contextPanel: document.getElementById('contextPanel'),
  factsPanel: document.getElementById('factsPanel'),
  activityPanel: document.getElementById('activityPanel'),
  welcomeCard: document.getElementById('welcomeCard'),
  welcomeNote: document.getElementById('welcomeNote'),
  historyDrawer: document.getElementById('historyDrawer'),
  historyList: document.getElementById('historyList'),
  historyPreview: document.getElementById('historyPreview'),
  closeHistoryButton: document.getElementById('closeHistoryButton'),
  permissionSelect: document.getElementById('permissionSelect'),
  /* 新增面板元素 */
  mcpPanel: document.getElementById('mcpPanel'),          // MCP 服务器面板
  toolsPanel: document.getElementById('toolsPanel'),      // 工具控制面板
  todosPanel: document.getElementById('todosPanel'),       // 任务管理面板
  usagePanel: document.getElementById('usagePanel'),    // Usage 面板
  loginScreen: document.getElementById('loginScreen'),    // 登录遮罩层
  loginError: document.getElementById('loginError'),     // 登录错误提示
  loginClaudeAi: document.getElementById('loginClaudeAi'), // Claude.ai 订阅登录
  loginConsole: document.getElementById('loginConsole'),   // Console 登录
  loginCancel: document.getElementById('loginCancel'),     // 取消登录
  attachButton: document.getElementById('attachButton'),   // 附件按钮
  attachmentsPreview: document.getElementById('attachmentsPreview'), // 附件预览区
  stopButton: document.getElementById('stopButton'),       // 停止按钮
  /* Slash 命令自动补全弹出层 */
  slashPopup: document.getElementById('slashPopup'),
  /* 会话标签栏 */
  sessionTabs: document.getElementById('sessionTabs'),
};

/** 详情面板的切换按钮列表 */
const detailButtons = Array.from(document.querySelectorAll('.details-tabs [data-panel]'));

/* ============================================================
 * 二、UI 状态管理
 * 跟踪当前面板、历史记录、消息数量等 UI 层状态
 * ============================================================ */
const uiState = {
  openPanel: null,         // 当前打开的详情面板 (context/facts/activity/mcp/tools/todos)
  lastPanel: 'context',    // 上次打开的面板，用于切换回来
  historyOpen: false,      // 历史记录抽屉是否展开
  lastMessageCount: 0,     // 上一次渲染时的消息数量
  lastStreamingTextLength: 0, // 上一次流式文本长度
  optimisticUserText: '',  // 乐观更新：用户发送的文本
  optimisticUserTimestamp: '', // 乐观更新的时间戳
  slashFilterText: '',     // Slash 命令过滤文本
  slashPopupVisible: false, // Slash 弹出是否可见
};

/** 当前完整状态（从 extension.js 推送） */
let currentState = null;

/** webview 本地图片存储：key = 用户消息文本, value = 图片 data URL 数组 */
const sentImagesMap = new Map();
/** 是否正在进行输入法组合（如中文输入） */
let isPromptComposing = false;
/** 待确认的提示文本 */
let pendingPromptText = '';

/* ============================================================
 * Inline diff renderer for permission card
 * ============================================================ */
function renderInlineDiff(fileName, original, proposed) {
  const oldLines = original.split('\n');
  const newLines = proposed.split('\n');
  let html = `<div class="inline-diff-header">${escapeHtml(fileName)}</div>`;
  // Simple line-by-line diff
  const maxLen = Math.max(oldLines.length, newLines.length);
  const diffLines = [];
  // Find changed region
  let i = 0, j = oldLines.length - 1, k = newLines.length - 1;
  while (i < oldLines.length && i < newLines.length && oldLines[i] === newLines[i]) i++;
  while (j >= i && k >= i && oldLines[j] === newLines[k]) { j--; k--; }
  // Context before (up to 3 lines)
  const ctxStart = Math.max(0, i - 3);
  for (let n = ctxStart; n < i; n++) {
    diffLines.push(`<div class="diff-ctx"> ${escapeHtml(oldLines[n])}</div>`);
  }
  // Removed lines
  for (let n = i; n <= j; n++) {
    diffLines.push(`<div class="diff-del">-${escapeHtml(oldLines[n])}</div>`);
  }
  // Added lines
  for (let n = i; n <= k; n++) {
    diffLines.push(`<div class="diff-add">+${escapeHtml(newLines[n])}</div>`);
  }
  // Context after (up to 3 lines)
  const ctxEnd = Math.min(oldLines.length, j + 4);
  for (let n = j + 1; n < ctxEnd; n++) {
    diffLines.push(`<div class="diff-ctx"> ${escapeHtml(oldLines[n])}</div>`);
  }
  if (diffLines.length === 0) {
    diffLines.push(`<div class="diff-add">+${escapeHtml(proposed)}</div>`);
  }
  return html + diffLines.join('');
}

/* ============================================================
 * 三、布莱叶盲文旋转动画
 * 用于等待状态的加载指示器
 * ============================================================ */
const BRAILLE_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let brailleSpinnerFrame = 0;

/** 刷新所有 [data-braille-spinner] 元素的动画帧 */
function tickBrailleSpinners() {
  const frame = BRAILLE_SPINNER_FRAMES[brailleSpinnerFrame % BRAILLE_SPINNER_FRAMES.length];
  document.querySelectorAll('[data-braille-spinner]').forEach(element => {
    element.textContent = frame;
  });
  brailleSpinnerFrame += 1;
}

window.setInterval(tickBrailleSpinners, 90);

/* ============================================================
 * 四、工具函数
 * ============================================================ */

/** HTML 转义，防止 XSS 注入 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 截断会话 ID 用于显示 */
function shortSessionId(value) {
  if (!value) return 'Awaiting session';
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

/** 提取文件名（路径最后一段） */
function basename(value) {
  if (!value) return 'unknown';
  return String(value).split(/[\\/]/).pop() || value;
}

/** 格式化频率限制摘要文本 */
function formatRateLimitSummary(rateLimit) {
  if (!rateLimit) return '';
  if (rateLimit.status === 'rejected') {
    const resetsAt = rateLimit.resetsAt ? new Date(rateLimit.resetsAt * 1000) : null;
    if (resetsAt) {
      const mins = Math.max(0, Math.ceil((resetsAt - Date.now()) / 60000));
      return `Rate limited. Resets in ~${mins} min.`;
    }
    return 'Rate limited. Please wait.';
  }
  return '';
}

/** 格式化时间为 HH:MM 显示 */
function formatTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** 格式化日期时间（含月日） */
function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** 格式化美元金额 */
function formatUsd(value) {
  if (typeof value !== 'number') return 'n/a';
  return `$${value.toFixed(4)}`;
}

/** 格式化频率限制重置时间 */
function formatResetTime(rateLimit) {
  if (!rateLimit || typeof rateLimit.resetsAt !== 'number') return '';
  const date = new Date(rateLimit.resetsAt * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** 截断行内文本到指定长度 */
function truncateInlineText(value, limit = 140) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/** 获取当前选中的模型 Profile */
function getSelectedProfile(state) {
  return (state.modelProfiles || []).find(profile => profile.id === state.activeProfileId) || null;
}

/** 获取当前选中的模型信息 */
function getSelectedModelInfo(state) {
  return (state.availableModels || []).find(model => model.value === state.selectedModel) || null;
}

/** 在 select 元素中查找指定值的 option */
function findModelOption(selectElement, value) {
  if (!selectElement || typeof value !== 'string' || !value) return null;
  return Array.from(selectElement.options).find(option => option.value === value) || null;
}

/* ============================================================
 * 五、Markdown 渲染器
 * 将纯文本 Markdown 转换为 HTML，支持：
 * - 代码块 (```) 带语言标识
 * - 行内代码 (`)
 * - 标题 (# ## ###)
 * - 粗体 (**text**)
 * - 斜体 (*text*)
 * - 无序列表 (- item)
 * - 有序列表 (1. item)
 * - 表格 (| col | col |)
 * - 链接 ([text](url))
 * - Diff 高亮 (+/- 行)
 * ============================================================ */
function renderMarkdown(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const output = [];
  let inCodeBlock = false;    // 是否在代码块内
  let codeBlockLang = '';     // 代码块语言标识
  let codeLines = [];         // 代码块累积行
  let inTable = false;        // 是否在表格内
  let tableRows = [];         // 表格行累积
  let inList = false;         // 是否在列表内
  let listType = '';          // 列表类型 'ul' 或 'ol'
  let listItems = [];         // 列表项累积

  /**
   * 处理行内 Markdown 语法
   * 转换 **粗体**、*斜体*、`行内代码`、[链接](url)
   */
  function processInline(line) {
    let result = escapeHtml(line);
    // 行内代码 `code`
    result = result.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
    // 粗体 **bold**
    result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // 斜体 *italic*（排除已处理的粗体）
    result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
    // 链接 [text](url)
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="md-link" href="$2" title="$2">$1</a>');
    return result;
  }

  /** 关闭当前打开的列表 */
  function flushList() {
    if (!inList) return;
    const tag = listType === 'ol' ? 'ol' : 'ul';
    output.push(`<${tag} class="md-list">${listItems.join('')}</${tag}>`);
    inList = false;
    listItems = [];
  }

  /** 关闭当前打开的表格 */
  function flushTable() {
    if (!inTable) return;
    let html = '<div class="md-table-wrap"><table class="md-table">';
    tableRows.forEach((row, idx) => {
      const cells = row.split('|').filter(c => c.trim() !== '');
      const tag = idx === 0 ? 'th' : 'td';
      html += '<tr>' + cells.map(c => `<${tag}>${processInline(c.trim())}</${tag}>`).join('') + '</tr>';
    });
    html += '</table></div>';
    output.push(html);
    inTable = false;
    tableRows = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── 代码块处理 ──
    if (line.trim().startsWith('```')) {
      if (!inCodeBlock) {
        // 开始代码块，提取语言标识
        flushList();
        flushTable();
        codeBlockLang = line.trim().slice(3).trim();
        inCodeBlock = true;
        codeLines = [];
      } else {
        // 结束代码块，渲染代码内容和 Diff 高亮
        const langLabel = codeBlockLang ? `<span class="code-lang">${escapeHtml(codeBlockLang)}</span>` : '';
        const isDiff = codeBlockLang === 'diff';
        const codeContent = codeLines.map(cl => {
          const escaped = escapeHtml(cl);
          // Diff 模式：+ 开头绿色高亮，- 开头红色高亮
          if (isDiff || escaped.match(/^[+-]/)) {
            if (cl.startsWith('+')) return `<span class="diff-add">${escaped}</span>`;
            if (cl.startsWith('-')) return `<span class="diff-del">${escaped}</span>`;
            if (cl.startsWith('@')) return `<span class="diff-hunk">${escaped}</span>`;
          }
          return escaped;
        }).join('\n');
        output.push(`<div class="md-code-block">${langLabel}<pre><code>${codeContent}</code></pre></div>`);
        inCodeBlock = false;
        codeBlockLang = '';
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // ── 表格行检测（以 | 开头和结尾） ──
    if (line.trim().match(/^\|.*\|$/)) {
      flushList();
      // 跳过分隔行 (|---|---|)
      if (line.trim().match(/^\|[\s\-:|]+\|$/)) {
        if (!inTable) { inTable = true; }
        continue;
      }
      if (!inTable) { inTable = true; }
      tableRows.push(line.trim());
      continue;
    } else {
      flushTable();
    }

    // ── 空行处理 ──
    if (line.trim() === '') {
      flushList();
      output.push('');
      continue;
    }

    // ── 标题 # ## ### ──
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      flushList();
      const level = headingMatch[1].length;
      output.push(`<h${level + 1} class="md-heading md-h${level}">${processInline(headingMatch[2])}</h${level + 1}>`);
      continue;
    }

    // ── 无序列表 (- item 或 * item) ──
    const ulMatch = line.match(/^(\s*)[-*]\s+(.+)/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        flushList();
        inList = true;
        listType = 'ul';
      }
      listItems.push(`<li>${processInline(ulMatch[2])}</li>`);
      continue;
    }

    // ── 有序列表 (1. item) ──
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        flushList();
        inList = true;
        listType = 'ol';
      }
      listItems.push(`<li>${processInline(olMatch[2])}</li>`);
      continue;
    }

    flushList();

    // ── Diff 行检测（非代码块内的 +/- 开头行） ──
    if (line.match(/^diff --git/) || line.match(/^---\s+a\//) || line.match(/^\+\+\+\s+b\//)) {
      output.push(`<div class="diff-meta">${escapeHtml(line)}</div>`);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      output.push(`<div class="diff-add">${escapeHtml(line)}</div>`);
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      output.push(`<div class="diff-del">${escapeHtml(line)}</div>`);
      continue;
    }
    if (line.startsWith('@@')) {
      output.push(`<div class="diff-hunk">${escapeHtml(line)}</div>`);
      continue;
    }

    // ── 普通段落 ──
    output.push(`<p class="md-para">${processInline(line)}</p>`);
  }

  // 关闭未结束的代码块
  if (inCodeBlock) {
    const codeContent = codeLines.map(cl => escapeHtml(cl)).join('\n');
    output.push(`<div class="md-code-block"><pre><code>${codeContent}</code></pre></div>`);
  }
  flushList();
  flushTable();

  return output.join('\n');
}

/* ============================================================
 * 六、Thinking 内容解析器
 * 从消息文本中提取 <thinking>...</thinking> 标签的内容
 * 并生成可折叠的 UI 区块
 * ============================================================ */

/**
 * 解析文本中的 thinking 块
 * @param {string} text - 原始消息文本
 * @returns {{thinking: string, body: string}} - 分离后的思考内容和正文
 */
function parseThinkingBlocks(text) {
  if (!text) return { thinking: '', body: text || '' };
  const thinkingParts = [];
  // 匹配 <thinking>...</thinking> 或 <antThinking>...</antThinking>
  const cleaned = text.replace(/<(?:thinking|antThinking)>([\s\S]*?)<\/(?:thinking|antThinking)>/gi, (_, content) => {
    thinkingParts.push(content.trim());
    return '';
  });
  return {
    thinking: thinkingParts.join('\n\n'),
    body: cleaned.trim(),
  };
}

/**
 * 渲染 thinking 内容为可折叠的 HTML
 * @param {string} thinkingText - 思考过程文本
 * @returns {string} HTML 字符串
 */
function renderThinkingBlock(thinkingText, options) {
  if (!thinkingText) return '';
  const isOpen = options && options.open;
  const lineCount = thinkingText.split('\n').length;
  return `
    <details class="thinking-bubble"${isOpen ? ' open' : ''}>
      <summary class="thinking-bubble-summary">
        <span class="thinking-bubble-icon">⬢</span>
        <span class="thinking-bubble-label">Thinking Process</span>
        <span class="thinking-bubble-count">${lineCount} lines</span>
      </summary>
      <div class="thinking-bubble-content">${renderMarkdown(thinkingText)}</div>
    </details>
  `;
}

/* ============================================================
 * 七、输入框相关工具函数
 * ============================================================ */

/** 自动调整输入框高度（根据内容） */
function autoSizePromptInput() {
  elements.promptInput.style.height = 'auto';
  elements.promptInput.style.height = `${Math.min(elements.promptInput.scrollHeight, 120)}px`;
}

/** 更新输入框和发送按钮的状态（是否有内容、是否可发送） */
function updateComposerDraftState(state = currentState || {}) {
  const hasText = elements.promptInput.value.trim().length > 0;
  const blocked = Boolean(state.pendingPermission) || Boolean(state.busy);
  elements.composer.classList.toggle('composer--has-input', hasText);
  elements.composer.classList.toggle('composer--empty', !hasText);
  // Show stop button only when busy AND input is empty; otherwise show send button
  const isBusy = Boolean(state.busy) && state.sessionState === 'running';
  const showStop = isBusy && !hasText;
  if (elements.stopButton) {
    elements.stopButton.classList.toggle('hidden', !showStop);
  }
  elements.sendButton.classList.toggle('hidden', showStop);
  elements.sendButton.disabled = showStop || !hasText;
}

/** 安全绑定事件（元素不存在时跳过） */
function bindEvent(element, eventName, handler) {
  if (!element) return;
  element.addEventListener(eventName, handler);
}

/** 检查是否可以提交提示 */
function canSubmitPrompt() {
  return Boolean(
    currentState &&
      !currentState.pendingPermission &&
      !currentState.busy &&
      elements.promptInput.value.trim(),
  );
}

/* ============================================================
 * 八、Slash 命令自动补全系统
 * 当用户输入 / 开头的文本时，显示可用命令列表
 * 支持模糊过滤和键盘选择
 * ============================================================ */

/** 获取当前可用的 slash 命令列表 */
function getSlashCommands(state) {
  const commands = [];
  // 从后端运行时获取的命令
  if (state?.runtime?.slashCommands) {
    state.runtime.slashCommands.forEach(cmd => {
      commands.push({
        name: cmd.name || cmd,
        description: cmd.description || '',
        source: 'runtime',
      });
    });
  }
  // 内置常用命令（如果后端没有返回）
  const builtinCmds = [
    { name: '/compact', description: '压缩对话上下文' },
    { name: '/review', description: '审查代码变更' },
    { name: '/commit', description: '提交代码更改' },
    { name: '/help', description: '查看帮助信息' },
    { name: '/plan', description: '进入计划模式' },
    { name: '/clear', description: '清空对话' },
    { name: '/config', description: '查看/修改配置' },
    { name: '/cost', description: '查看当前费用' },
    { name: '/doctor', description: '诊断问题' },
    { name: '/init', description: '初始化 CLAUDE.md' },
    { name: '/memory', description: '管理记忆' },
    { name: '/permissions', description: '查看权限设置' },
    { name: '/status', description: '查看状态' },
    { name: '/terminal-setup', description: '配置终端' },
    { name: '/vim', description: '切换 vim 模式' },
  ];
  // 去重：已从后端获取的不重复添加
  const existingNames = new Set(commands.map(c => c.name));
  builtinCmds.forEach(cmd => {
    if (!existingNames.has(cmd.name)) {
      commands.push({ ...cmd, source: 'builtin' });
    }
  });
  return commands;
}

/**
 * 渲染 Slash 命令自动补全弹出框
 * @param {string} filterText - 用户当前输入的过滤文本
 */
function renderSlashPopup(filterText) {
  if (!elements.slashPopup || !currentState) return;

  const allCmds = getSlashCommands(currentState);
  const filter = filterText.toLowerCase();
  // 过滤匹配的命令
  const filtered = filter
    ? allCmds.filter(c => c.name.toLowerCase().includes(filter) || c.description.toLowerCase().includes(filter))
    : allCmds;

  if (filtered.length === 0) {
    elements.slashPopup.classList.add('hidden');
    uiState.slashPopupVisible = false;
    return;
  }

  elements.slashPopup.innerHTML = filtered.map(cmd =>
    `<button class="slash-item" data-slash-cmd="${escapeHtml(cmd.name)}" type="button">
      <span class="slash-name">${escapeHtml(cmd.name)}</span>
      <span class="slash-desc">${escapeHtml(cmd.description)}</span>
    </button>`
  ).join('');

  elements.slashPopup.classList.remove('hidden');
  uiState.slashPopupVisible = true;
}

/** 隐藏 Slash 命令弹出框 */
function hideSlashPopup() {
  if (elements.slashPopup) {
    elements.slashPopup.classList.add('hidden');
  }
  uiState.slashPopupVisible = false;
}

/* ============================================================
 * 九、渲染函数 —— 各 UI 区域的渲染逻辑
 * ============================================================ */

/** 渲染会话元信息（底部状态栏） */
function renderSessionMeta(state) {
  const selectedProfile = getSelectedProfile(state);
  const runtimeModel = state.runtime?.model || state.selectedModel || 'default';
  const meta = [basename(state.cwd || 'Workspace')];
  const interaction = state.interactionStatus;

  if (state.sessionState && state.sessionState !== 'idle') meta.push(state.sessionState);
  if (runtimeModel) meta.push(runtimeModel);
  if (selectedProfile) meta.push(selectedProfile.label);

  const metaMarkup = meta.map(part => escapeHtml(part)).join(' <span class="meta-sep">•</span> ');
  const rateLimitSummary = formatRateLimitSummary(state.rateLimit);
  let tone = 'normal';
  let markup = metaMarkup;
  let title = meta.join(' • ');

  if (state.pendingPermission) {
    tone = 'warn';
    markup = 'Approval required <span class="meta-sep">•</span> review the pending tool request';
    title = 'Approval required';
  } else if (interaction?.status === 'pending') {
    tone = 'busy';
    markup = escapeHtml(interaction.message || 'Applying change...');
    title = interaction.message || 'Applying change...';
  } else if (interaction?.status === 'error') {
    tone = 'error';
    markup = escapeHtml(interaction.message || 'Change failed.');
    title = interaction.message || 'Change failed.';
  } else if (state.busy) {
    tone = 'busy';
    markup = `${metaMarkup} <span class="meta-sep">•</span> MAGI thinking`;
    title = `${meta.join(' • ')} • MAGI thinking`;
  } else if (state.rateLimit?.status === 'rejected') {
    tone = 'warn';
    markup = `Reply blocked <span class="meta-sep">•</span> ${escapeHtml(truncateInlineText(rateLimitSummary || 'Usage limit reached.', 120))}`;
    title = rateLimitSummary || 'Usage limit reached.';
  } else if (state.lastError) {
    tone = 'error';
    markup = `Reply failed <span class="meta-sep">•</span> ${escapeHtml(truncateInlineText(state.lastError, 140))}`;
    title = state.lastError;
  } else if (interaction?.status === 'success') {
    markup = escapeHtml(interaction.message || title);
    title = interaction.message || title;
  }

  elements.sessionMeta.classList.remove('composer-hint--busy', 'composer-hint--warn', 'composer-hint--error');
  if (tone === 'busy') elements.sessionMeta.classList.add('composer-hint--busy');
  else if (tone === 'warn') elements.sessionMeta.classList.add('composer-hint--warn');
  else if (tone === 'error') elements.sessionMeta.classList.add('composer-hint--error');

  elements.sessionMeta.innerHTML = markup;
  elements.sessionMeta.title = title;
}

/** 渲染模型选择器下拉菜单 */
function renderModelPicker(state) {
  const profiles = Array.isArray(state.modelProfiles) ? state.modelProfiles : [];
  const availableModels = Array.isArray(state.availableModels) ? state.availableModels : [];
  const profileOptions = profiles.map(profile => ({
    value: profile.id,
    label: state.defaultProfileId && profile.id === state.defaultProfileId
      ? `${profile.label} (default)` : profile.label,
    description: profile.description || profile.model,
  }));
  // 去重：profile 中已有的模型不在 backend 列表中重复显示
  const profileModels = new Set(profiles.map(p => p.model?.toLowerCase()));
  const profileIds = new Set(profiles.map(p => p.id));
  const modelOptions = availableModels.map(model => ({
    value: model.value,
    label: model.displayName || model.value,
    description: model.description || model.value,
  })).filter(option => {
    if (profileOptions.length > 0 && option.value === 'default') return false;
    if (profileIds.has(option.value)) return false;
    if (profileModels.has(option.value?.toLowerCase())) return false;
    if (profileModels.has(option.label?.toLowerCase())) return false;
    return true;
  });

  if (profileOptions.length === 0 && modelOptions.length === 0) {
    modelOptions.push({
      value: state.selectedModel || 'default',
      label: state.selectedModel || 'default',
      description: 'Waiting for backend model metadata.',
    });
  }

  const allOptions = [...profileOptions, ...modelOptions];
  // 如果 selectedModel 不在选项列表里（如内置别名 sonnet/opus/haiku），动态添加
  // 但跳过已被 profile 覆盖的模型（profile.id ≠ profile.model，两者都应算匹配）
  const selectedModelValue = state.selectedModel || '';
  const profileModelNames = new Set(profiles.map(p => p.model?.toLowerCase()).filter(Boolean));
  if (selectedModelValue && selectedModelValue !== 'default' &&
      !allOptions.some(opt => opt.value === selectedModelValue) &&
      !profileModelNames.has(selectedModelValue.toLowerCase())) {
    const label = selectedModelValue.charAt(0).toUpperCase() + selectedModelValue.slice(1);
    allOptions.push({ value: selectedModelValue, label, description: `Model: ${selectedModelValue}` });
  }
  // Resolve selectedModel to profile ID if it matches a profile's model name
  const matchingProfile = profiles.find(p => p.model?.toLowerCase() === selectedModelValue.toLowerCase());
  const resolvedSelectedModel = matchingProfile ? matchingProfile.id : selectedModelValue;
  // 优先级：pending > activeProfile > selectedModel(resolved) > 第一个选项
  const currentValue =
    state.pendingModelValue ||
    state.activeProfileId ||
    (resolvedSelectedModel && allOptions.some(o => o.value === resolvedSelectedModel) ? resolvedSelectedModel : '') ||
    profileOptions[0]?.value ||
    modelOptions[0]?.value || '';

  elements.modelSelect.innerHTML = allOptions
    .map(option => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
    .join('');
  const availableValues = Array.from(elements.modelSelect.options).map(option => option.value);
  const resolvedValue = availableValues.includes(currentValue) ? currentValue : availableValues[0] || '';
  if (resolvedValue) elements.modelSelect.value = resolvedValue;

  const selectedOption = allOptions.find(option => option.value === elements.modelSelect.value) || allOptions[0];
  const selectedProfile = profiles.find(profile => profile.id === elements.modelSelect.value) || getSelectedProfile(state);
  const selectedModel = availableModels.find(model => model.value === elements.modelSelect.value) || getSelectedModelInfo(state);
  const usingProfile = Boolean(selectedProfile && selectedProfile.id === elements.modelSelect.value);

  elements.modelSelect.title = usingProfile
    ? selectedProfile.description || 'Profile route'
    : selectedModel?.description || selectedOption?.description || 'Runtime model';
}

/** 渲染交互控制区（Thinking、权限选择器、Plan 模式等按钮状态同步） */
function renderInteractionControls(state) {
  const pendingThinking = state.pendingThinkingMode || state.thinkingMode || 'adaptive';
  if (findModelOption(elements.thinkingSelect, pendingThinking)) {
    elements.thinkingSelect.value = pendingThinking;
  } else {
    elements.thinkingSelect.value = 'adaptive';
  }
  elements.thinkingSelect.title =
    elements.thinkingSelect.options[elements.thinkingSelect.selectedIndex]?.textContent || 'Thinking mode';
  elements.modelSelect.parentElement.classList.toggle('chip-select--pending', Boolean(state.pendingModelValue));
  elements.thinkingSelect.parentElement.classList.toggle('chip-select--pending', Boolean(state.pendingThinkingMode));
  // 同步权限模式选择器
  if (elements.permissionSelect) {
    const permMode = state.permissionMode || 'default';
    if (findModelOption(elements.permissionSelect, permMode)) {
      elements.permissionSelect.value = permMode;
    }
  }
  elements.planModeToggleButton.classList.toggle('chip--active', Boolean(state.planModeEnabled));
  elements.planModeToggleButton.setAttribute('aria-pressed', state.planModeEnabled ? 'true' : 'false');
  elements.ideContextToggleButton.classList.toggle('chip--active', Boolean(state.ideContextEnabled));
  elements.ideContextToggleButton.setAttribute('aria-pressed', state.ideContextEnabled ? 'true' : 'false');
  if (elements.panelToggleButton) {
    elements.panelToggleButton.classList.toggle('chip--active', Boolean(uiState.openPanel));
    elements.panelToggleButton.setAttribute('aria-pressed', uiState.openPanel ? 'true' : 'false');
  }
}

/** 渲染频率限制警告 — 仅在接近或达到限额时显示 */
function renderRateLimit(state) {
  // 只在 rejected（已达限额）或 allowed_warning（接近限额）时显示
  if (!state.rateLimit || (state.rateLimit.status !== 'rejected' && state.rateLimit.status !== 'allowed_warning')) {
    elements.rateLimit.classList.add('hidden');
    elements.rateLimit.innerHTML = '';
    return;
  }
  const resetTime = formatResetTime(state.rateLimit);
  const details = [state.rateLimit.rateLimitType, resetTime ? `resets ${resetTime}` : ''].filter(Boolean).join(' - ');
  elements.rateLimit.classList.remove('hidden');
  elements.rateLimit.innerHTML = `
    <strong>${escapeHtml(state.rateLimit.status === 'rejected' ? 'Usage limit reached' : 'Usage warning')}</strong>
    <span>${escapeHtml(details || 'NERV CODE reported a usage update.')}</span>
  `;
}

/** 渲染工具授权请求卡片 */
function renderPermission(state) {
  const pending = state.pendingPermission;
  if (!pending) {
    elements.permissionCard.classList.add('hidden');
    return;
  }
  elements.permissionCard.classList.remove('hidden');
  elements.permissionTitle.textContent = pending.title || pending.toolName || 'Authorization request';
  elements.permissionDescription.textContent = pending.description || `MAGI requests approval to use ${pending.toolName}.`;

  // Render inline diff if available, otherwise show raw input JSON
  if (pending.diff) {
    const fileName = pending.diff.filePath.replace(/\\/g, '/').split('/').pop();
    elements.permissionInput.innerHTML = renderInlineDiff(fileName, pending.diff.original, pending.diff.proposed);
  } else {
    elements.permissionInput.textContent = JSON.stringify(pending.input || {}, null, 2);
  }
}

/**
 * 渲染消息为 HTML（带 Markdown 渲染 + Thinking 展示 + Diff 高亮）
 * @param {object} message - 消息对象 {role, text, tone, timestamp}
 * @returns {string} HTML 字符串
 */
function renderMessageBody(message) {
  const text = message.text || '';

  // 用户消息：简单转义 + 换行 + 附带图片（从 webview 本地 Map 读取）
  if (message.role === 'user') {
    let html = escapeHtml(text).replace(/\n/g, '<br>');
    const images = sentImagesMap.get(text.trim());
    if (images && images.length > 0) {
      html += '<div class="user-images">' +
        images.map(src =>
          `<img src="${src}" class="user-pasted-image" alt="pasted image" />`
        ).join('') + '</div>';
    }
    return html;
  }

  // AI 回复：解析 thinking + Markdown 渲染（thinking 作为小气泡放在正文后面）
  const { thinking, body } = parseThinkingBlocks(text);
  const thinkingHtml = renderThinkingBlock(thinking);
  const bodyHtml = renderMarkdown(body);
  return bodyHtml + thinkingHtml;
}

/** 渲染会话消息列表（主聊天区域） */
function renderTranscript(state) {
  const messages = Array.isArray(state.messages) ? state.messages : [];
  const streamingText = typeof state.streamingAssistantText === 'string' ? state.streamingAssistantText : '';
  const optimisticCommitted = Boolean(
    uiState.optimisticUserText &&
      messages.some(message => message.role === 'user' && message.text.trim() === uiState.optimisticUserText),
  );
  if (optimisticCommitted) {
    uiState.optimisticUserText = '';
    uiState.optimisticUserTimestamp = '';
  }
  const hasStreamingText = streamingText.length > 0;
  const hasStreamingThinking = (state.streamingThinkingText || '').length > 0;
  const showThinkingBubble =
    Boolean(state.busy) && state.sessionState === 'running' &&
    !state.pendingPermission && state.backendStatus === 'online' && !hasStreamingText && !hasStreamingThinking;
  const showStreamingBubble =
    Boolean(state.busy) && state.sessionState === 'running' &&
    !state.pendingPermission && state.backendStatus === 'online' && (hasStreamingText || hasStreamingThinking);
  const previousMessageCount = uiState.lastMessageCount;
  const stickToBottom =
    elements.transcript.scrollHeight - elements.transcript.scrollTop - elements.transcript.clientHeight < 40 ||
    messages.length > previousMessageCount ||
    streamingText.length !== uiState.lastStreamingTextLength ||
    showThinkingBubble;

  /**
   * 生成 thinking 气泡 HTML
   * 显示加载动画，表示 AI 正在思考
   */
  const thinkingBubbleHtml = `
    <article class="message message--assistant message--placeholder">
      <div class="message-meta"><span>MAGI</span><span>thinking</span></div>
      <div class="message-body message-body--placeholder">
        <span class="braille-spinner" data-braille-spinner aria-hidden="true">⠋</span>
        <span>Thinking...</span>
      </div>
    </article>`;

  /**
   * 生成流式回复气泡 HTML
   * 实时显示 AI 正在生成的文本，包括思考过程
   */
  const streamingThinking = state.streamingThinkingText || '';
  const streamingThinkingHtml = streamingThinking
    ? renderThinkingBlock(streamingThinking, { open: true })
    : '';
  const streamingBubbleHtml = `
    <article class="message message--assistant message--streaming">
      <div class="message-meta"><span>MAGI</span><span>streaming</span></div>
      <div class="message-body">${streamingThinkingHtml}${renderMarkdown(streamingText)}</div>
    </article>`;

  if (messages.length === 0) {
    if (uiState.optimisticUserText) {
      let html = `
        <article class="message message--user message--pending">
          <div class="message-meta"><span>You</span><span>${escapeHtml(formatTimestamp(uiState.optimisticUserTimestamp))}</span></div>
          <div class="message-body">${escapeHtml(uiState.optimisticUserText).replace(/\n/g, '<br>')}</div>
        </article>`;
      if (showThinkingBubble) html += thinkingBubbleHtml;
      else if (showStreamingBubble) html += streamingBubbleHtml;
      elements.transcript.innerHTML = html;
    } else if (showStreamingBubble) {
      elements.transcript.innerHTML = streamingBubbleHtml;
    } else if (showThinkingBubble) {
      elements.transcript.innerHTML = thinkingBubbleHtml;
    } else {
      elements.transcript.innerHTML = '<div class="transcript-empty"></div>';
    }
  } else {
    // 渲染所有消息（带 Markdown + Thinking）
    // Consecutive assistant messages' thinking blocks are consolidated into
    // a single collapsible bubble placed AFTER the final text response.
    const transcriptMarkup = (() => {
      const result = [];
      let i = 0;
      while (i < messages.length) {
        const message = messages[i];
        if (message.role !== 'assistant') {
          // user / system / other: render individually
          const speaker = message.role === 'user' ? 'You' : 'MAGI';
          const bodyHtml = renderMessageBody(message);
          result.push(`
            <article class="message message--${escapeHtml(message.role)} message--tone-${escapeHtml(message.tone || message.role)}">
              <div class="message-meta">
                <span>${escapeHtml(speaker)}</span>
                <span>${escapeHtml(formatTimestamp(message.timestamp))}</span>
              </div>
              <div class="message-body">${bodyHtml}</div>
            </article>`);
          i++;
          continue;
        }
        // Collect consecutive assistant messages into one group
        const groupThinking = [];
        const groupBodies = [];
        let lastTimestamp = message.timestamp;
        let lastTone = message.tone || message.role;
        while (i < messages.length && messages[i].role === 'assistant') {
          const msg = messages[i];
          const { thinking, body } = parseThinkingBlocks(msg.text || '');
          if (thinking.trim()) groupThinking.push(thinking.trim());
          if (body.trim()) groupBodies.push(renderMarkdown(body));
          lastTimestamp = msg.timestamp;
          lastTone = msg.tone || msg.role;
          i++;
        }
        // Skip entirely empty groups
        if (groupBodies.length === 0 && groupThinking.length === 0) continue;
        // Build single consolidated thinking bubble + body
        const consolidatedThinking = groupThinking.length > 0
          ? renderThinkingBlock(groupThinking.join('\n\n'))
          : '';
        const consolidatedBody = groupBodies.join('');
        result.push(`
          <article class="message message--assistant message--tone-${escapeHtml(lastTone)}">
            <div class="message-meta">
              <span>MAGI</span>
              <span>${escapeHtml(formatTimestamp(lastTimestamp))}</span>
            </div>
            <div class="message-body">${consolidatedBody}${consolidatedThinking}</div>
          </article>`);
      }
      return result.join('');
    })();

    const optimisticMarkup = uiState.optimisticUserText
      ? (() => {
          const imgHtml = sentImagesMap.has(uiState.optimisticUserText)
            ? '<div class="user-images">' + sentImagesMap.get(uiState.optimisticUserText).map(src =>
                `<img src="${src}" class="user-pasted-image" alt="pasted image" />`
              ).join('') + '</div>'
            : '';
          return `<article class="message message--user message--pending">
            <div class="message-meta"><span>You</span><span>${escapeHtml(formatTimestamp(uiState.optimisticUserTimestamp))}</span></div>
            <div class="message-body">${escapeHtml(uiState.optimisticUserText).replace(/\n/g, '<br>')}${imgHtml}</div>
          </article>`;
        })()
      : '';

    if (showStreamingBubble) {
      elements.transcript.innerHTML = `${transcriptMarkup}${optimisticMarkup}${streamingBubbleHtml}`;
    } else if (showThinkingBubble) {
      elements.transcript.innerHTML = `${transcriptMarkup}${optimisticMarkup}${thinkingBubbleHtml}`;
    } else {
      elements.transcript.innerHTML = `${transcriptMarkup}${optimisticMarkup}`;
    }
  }

  if (stickToBottom) elements.transcript.scrollTop = elements.transcript.scrollHeight;
  uiState.lastMessageCount = messages.length;
  uiState.lastStreamingTextLength = streamingText.length;
  tickBrailleSpinners();
}

/** 渲染 IDE 上下文面板（活动编辑器、光标、选区等） */
function renderContext(state) {
  const active = state.ideContext?.activeEditor;
  const workspace = state.ideContext?.workspace;
  const visibleEditors = state.ideContext?.visibleEditors || [];
  const rows = [
    ['Active File', active?.path || 'none'],
    ['Language', active?.language || 'n/a'],
    ['Cursor', active ? `L${active.cursorLine}:C${active.cursorColumn}` : 'n/a'],
    ['Selection', active?.selection
      ? `L${active.selection.startLine}-${active.selection.endLine} (${active.selection.charCount} chars)` : 'none'],
    ['Visible Range', active?.visibleExcerpt
      ? `L${active.visibleExcerpt.startLine}-${active.visibleExcerpt.endLine}` : 'n/a'],
    ['Visible Editors', visibleEditors.length ? visibleEditors.map(editor => basename(editor.path)).join(', ') : 'none'],
    ['Workspace', workspace?.cwd || 'unknown'],
    ['Folders', String(workspace?.folders?.length || 0)],
    ['Root Items', workspace?.topLevelEntries?.length ? workspace.topLevelEntries.slice(0, 8).join(', ') : 'n/a'],
  ];
  elements.context.innerHTML = rows.map(([label, value]) => `
    <div class="fact-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>
  `).join('');
}

/** 渲染系统状态面板（运行时信息） */
function renderFacts(state) {
  const facts = [
    ['Workspace', state.cwd || 'unknown'],
    ['Session ID', shortSessionId(state.sessionId)],
    ['Model', state.runtime?.model || state.selectedModel || 'pending'],
    ['Version', state.runtime?.claudeCodeVersion || 'pending'],
    ['Permission', state.runtime?.permissionMode || state.permissionMode || 'default'],
    ['Tools', String(state.runtime?.tools?.length || 0)],
    ['MCP', String(state.runtime?.mcpServers?.length || 0)],
    ['Turns', String(state.lastResult?.numTurns || 0)],
    ['Last Cost', formatUsd(state.lastResult?.totalCostUsd)],
  ];
  elements.facts.innerHTML = facts.map(([label, value]) => `
    <div class="fact-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>
  `).join('');
}

/** 渲染操作日志面板（活动事件流） */
function renderActivity(state) {
  if (!state.activity || state.activity.length === 0) {
    elements.activity.innerHTML = '<div class="log-line muted">No events yet.</div>';
    return;
  }
  elements.activity.innerHTML = state.activity.map(entry => `
    <div class="log-line log-line--${escapeHtml(entry.level)}">
      <span class="log-time">${escapeHtml(formatTimestamp(entry.timestamp))}</span>
      <span class="log-text">${escapeHtml(entry.text)}</span>
    </div>
  `).join('');
}

/* ============================================================
 * 十、MCP 服务器面板渲染
 * 显示已连接的 MCP (Model Context Protocol) 服务器列表
 * 及其提供的工具信息
 * ============================================================ */
function renderMcpPanel(state) {
  if (!elements.mcpPanel) return;
  const servers = state.runtime?.mcpServers || [];
  if (servers.length === 0) {
    elements.mcpPanel.innerHTML = `
      <div class="mcp-empty">
        <p>No MCP servers connected.</p>
        <p class="mcp-hint">在 settings.json 中通过 <code>mcpServers</code> 配置 MCP 服务器，或在项目的 <code>.claude/settings.json</code> 中添加。</p>
      </div>`;
    return;
  }
  elements.mcpPanel.innerHTML = servers.map((server, idx) => {
    const name = typeof server === 'string' ? server : (server.name || server.id || `Server ${idx + 1}`);
    const status = server.status || 'connected';
    const tools = Array.isArray(server.tools) ? server.tools : [];
    const toolsHtml = tools.length > 0
      ? `<div class="mcp-tools">${tools.map(t => `<span class="mcp-tool-tag">${escapeHtml(typeof t === 'string' ? t : t.name || t)}</span>`).join('')}</div>`
      : '<span class="mcp-no-tools">No tools exposed</span>';
    return `
      <div class="mcp-server">
        <div class="mcp-server-header">
          <span class="mcp-status mcp-status--${escapeHtml(status)}">●</span>
          <strong>${escapeHtml(name)}</strong>
          <span class="mcp-server-status">${escapeHtml(status)}</span>
        </div>
        ${toolsHtml}
      </div>`;
  }).join('');
}

/* ============================================================
 * 十一、工具精细控制面板
 * 显示所有可用工具并提供 允许/拒绝 控制
 * 用户可以选择性地禁用某些工具
 * ============================================================ */
function renderToolsPanel(state) {
  if (!elements.toolsPanel) return;
  const tools = state.runtime?.tools || [];
  const toolDenylist = state.toolDenylist || [];

  if (tools.length === 0) {
    elements.toolsPanel.innerHTML = '<div class="tools-empty">Waiting for backend to report available tools...</div>';
    return;
  }

  elements.toolsPanel.innerHTML = `
    <div class="tools-header">
      <span class="tools-count">${tools.length} tools available</span>
      <button class="ghost ghost--small" id="resetToolsBtn" type="button">Reset All</button>
    </div>
    <div class="tools-list">
      ${tools.map(tool => {
        const toolName = typeof tool === 'string' ? tool : (tool.name || tool);
        const isDenied = toolDenylist.includes(toolName);
        return `
          <label class="tool-item ${isDenied ? 'tool-item--denied' : ''}">
            <input type="checkbox" class="tool-checkbox" data-tool-name="${escapeHtml(toolName)}" ${isDenied ? '' : 'checked'} />
            <span class="tool-name">${escapeHtml(toolName)}</span>
          </label>`;
      }).join('')}
    </div>`;
}

/* ============================================================
 * 十二、Todo / 任务管理面板
 * 显示 AI 报告的任务进度和用户自定义任务
 * ============================================================ */
function renderTodosPanel(state) {
  if (!elements.todosPanel) return;
  const todos = state.todos || [];
  const agents = state.agents || [];

  let html = '';

  // ── Agent 子代理区域 ──
  if (agents.length > 0) {
    html += `
      <div class="todos-section">
        <div class="todos-section-title">Agent Sub-processes</div>
        ${agents.map(agent => {
          const statusClass = agent.status === 'running' ? 'agent--running' :
                              agent.status === 'completed' ? 'agent--completed' : 'agent--error';
          return `
            <div class="agent-item ${statusClass}">
              <span class="agent-icon">${agent.status === 'running' ? '⠋' : agent.status === 'completed' ? '✓' : '✗'}</span>
              <div class="agent-info">
                <span class="agent-desc">${escapeHtml(agent.description || 'Agent task')}</span>
                <span class="agent-status">${escapeHtml(agent.status || 'unknown')}${agent.duration ? ` · ${agent.duration}` : ''}</span>
              </div>
            </div>`;
        }).join('')}
      </div>`;
  }

  // ── 任务列表区域 ──
  if (todos.length > 0) {
    html += `
      <div class="todos-section">
        <div class="todos-section-title">Tasks</div>
        ${todos.map(todo => {
          const icon = todo.status === 'completed' ? '✓' :
                       todo.status === 'in_progress' ? '⠋' : '○';
          const statusClass = `todo--${todo.status || 'pending'}`;
          return `
            <div class="todo-item ${statusClass}">
              <span class="todo-icon">${icon}</span>
              <span class="todo-text">${escapeHtml(todo.status === 'in_progress' ? (todo.activeForm || todo.content) : todo.content)}</span>
            </div>`;
        }).join('')}
      </div>`;
  }

  if (!html) {
    html = '<div class="todos-empty">No active tasks or agents.</div>';
  }

  elements.todosPanel.innerHTML = html;
}

/* ============================================================
 * Usage 面板渲染
 * 显示会话累计花费、轮数和每轮明细
 * ============================================================ */
/** 格式化重置倒计时 */
function formatResetCountdown(resetsAt) {
  if (!resetsAt) return '';
  const resetDate = new Date(resetsAt);
  if (Number.isNaN(resetDate.getTime())) return '';
  const diffMs = resetDate - Date.now();
  if (diffMs <= 0) return 'now';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

/** 渲染单个配额进度条 */
function renderUsageLimitBar(title, limit) {
  if (!limit || limit.utilization === null || limit.utilization === undefined) return '';
  const pct = Math.floor(limit.utilization);
  const resetText = limit.resets_at ? `Resets in ${formatResetCountdown(limit.resets_at)}` : '';
  const fillClass = pct >= 90 ? ' usage-bar-fill--critical' : pct >= 70 ? ' usage-bar-fill--warn' : '';
  return `
    <div class="usage-limit">
      <div class="usage-limit-header">
        <span class="usage-limit-title">${escapeHtml(title)}</span>
        <span class="usage-limit-pct">${escapeHtml(String(pct))}%</span>
      </div>
      <div class="usage-bar"><div class="usage-bar-fill${fillClass}" style="width:${Math.min(pct, 100)}%"></div></div>
      ${resetText ? `<div class="usage-bar-reset">${escapeHtml(resetText)}</div>` : ''}
    </div>`;
}

function renderUsagePanel(state) {
  if (!elements.usagePanel) return;
  const util = state.utilization;
  const history = state.usageHistory || [];
  const totalCost = typeof state.totalCostUsd === 'number' ? state.totalCostUsd : 0;
  const totalTurns = state.totalTurns || 0;
  const totalDuration = history.reduce((sum, h) => sum + (h.durationMs || 0), 0);
  const modelLabel = state.runtime?.model || state.selectedModel || 'unknown';

  let html = '';

  // ── Utilization quota bars (when available from backend) ──
  if (util && (util.five_hour || util.seven_day || util.seven_day_sonnet)) {
    html += '<div class="usage-section">';
    html += '<div class="usage-section-title">Quota</div>';
    html += renderUsageLimitBar('Session (5hr)', util.five_hour);
    html += renderUsageLimitBar('Weekly (7 day)', util.seven_day);
    html += renderUsageLimitBar('Weekly Sonnet', util.seven_day_sonnet);
    if (util.extra_usage && util.extra_usage.is_enabled && typeof util.extra_usage.utilization === 'number') {
      html += renderUsageLimitBar('Extra Usage', {
        utilization: util.extra_usage.utilization,
        resets_at: null,
      });
    }
    html += '</div>';
  }

  // ── Session stats (always shown) ──
  html += '<div class="usage-section">';
  html += `<div class="usage-section-title">Session · ${escapeHtml(modelLabel)}</div>`;
  const timeStr = totalDuration >= 60000
    ? (totalDuration / 60000).toFixed(1) + 'min'
    : totalDuration >= 1000 ? (totalDuration / 1000).toFixed(1) + 's' : totalDuration + 'ms';
  html += '<div class="usage-summary">';
  html += `<div class="usage-summary-row"><dt>Turns</dt><dd>${escapeHtml(String(totalTurns))}</dd></div>`;
  html += `<div class="usage-summary-row"><dt>Total Time</dt><dd>${escapeHtml(timeStr)}</dd></div>`;
  if (totalCost > 0) {
    html += `<div class="usage-summary-row"><dt>Total Cost</dt><dd>${escapeHtml(formatUsd(totalCost))}</dd></div>`;
  }
  html += '</div></div>';

  // ── Per-turn detail list ──
  if (history.length > 0) {
    const hasCost = history.some(e => typeof e.cost === 'number' && e.cost > 0);
    html += '<div class="usage-section">';
    html += '<div class="usage-section-title">Turn Details</div>';
    html += '<div class="usage-list">';
    const reversed = [...history].reverse();
    for (const entry of reversed) {
      const durationStr = typeof entry.durationMs === 'number'
        ? (entry.durationMs >= 1000 ? (entry.durationMs / 1000).toFixed(1) + 's' : entry.durationMs + 'ms')
        : 'n/a';
      const apiStr = typeof entry.durationApiMs === 'number'
        ? (entry.durationApiMs >= 1000 ? (entry.durationApiMs / 1000).toFixed(1) + 's' : entry.durationApiMs + 'ms')
        : '';
      const entryTimeStr = entry.timestamp ? formatTimestamp(entry.timestamp) : '';
      const errorClass = entry.isError ? ' usage-item--error' : '';
      const costCell = hasCost
        ? `<span class="usage-cost">${escapeHtml(typeof entry.cost === 'number' ? formatUsd(entry.cost) : 'n/a')}</span>`
        : '';
      html += `
        <div class="usage-item${errorClass}">
          <span class="usage-turn">#${escapeHtml(String(entry.turnIndex))}</span>
          ${costCell}
          <span class="usage-duration">${escapeHtml(durationStr)}${apiStr ? ' <span class="usage-api">API ' + escapeHtml(apiStr) + '</span>' : ''}</span>
          <span class="usage-time">${escapeHtml(entryTimeStr)}</span>
        </div>`;
    }
    html += '</div></div>';
  }

  if (!html) {
    html = '<div class="usage-empty">No usage data yet. Send a message to start tracking.</div>';
  }

  elements.usagePanel.innerHTML = html;
}

/* ============================================================
 * 十三、多会话标签栏渲染
 * 显示所有并行会话的标签页，支持切换和创建新会话
 * ============================================================ */
function renderSessionTabs(state) {
  if (!elements.sessionTabs) return;
  const sessions = state.parallelSessions || [];
  const activeId = state.activeSessionId || state.sessionId;

  if (sessions.length <= 1) {
    // 只有一个会话时不显示标签栏
    elements.sessionTabs.classList.add('hidden');
    return;
  }

  elements.sessionTabs.classList.remove('hidden');
  elements.sessionTabs.innerHTML = sessions.map((session, idx) => {
    const isActive = session.id === activeId;
    const label = session.title || `Session ${idx + 1}`;
    return `
      <button class="session-tab ${isActive ? 'session-tab--active' : ''}" data-session-id="${escapeHtml(session.id)}" type="button">
        <span class="session-tab-label">${escapeHtml(label)}</span>
        ${sessions.length > 1 ? `<span class="session-tab-close" data-close-session="${escapeHtml(session.id)}">×</span>` : ''}
      </button>`;
  }).join('') + `<button class="session-tab session-tab--add" id="addSessionBtn" type="button" title="New parallel session">+</button>`;
}

/* ============================================================
 * 十四、详情面板可见性控制
 * 管理所有详情面板（IDE Context / System State / Log / MCP / Tools / Todos）的显示/隐藏
 * ============================================================ */
function applyDetailsVisibility() {
  const openPanel = uiState.openPanel;
  // 所有可切换的面板映射
  const panels = {
    context: elements.contextPanel,
    facts: elements.factsPanel,
    activity: elements.activityPanel,
    mcp: elements.mcpPanel,
    tools: elements.toolsPanel,
    todos: elements.todosPanel,
    usage: elements.usagePanel,
  };
  const titles = {
    context: 'IDE Context',
    facts: 'System State',
    activity: 'Operation Log',
    mcp: 'MCP Servers',
    tools: 'Tool Control',
    todos: 'Tasks & Agents',
    usage: 'Usage & Cost',
  };

  const hasOpenPanel = Boolean(openPanel && panels[openPanel]);
  elements.detailsDrawer.classList.toggle('hidden', !hasOpenPanel);

  Object.entries(panels).forEach(([name, panel]) => {
    if (panel) panel.classList.toggle('hidden', name !== openPanel);
  });

  detailButtons.forEach(button => {
    const isActive = button.dataset.panel === openPanel;
    button.classList.toggle('chip--active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
  if (elements.panelToggleButton) {
    elements.panelToggleButton.classList.toggle('chip--active', hasOpenPanel);
    elements.panelToggleButton.setAttribute('aria-pressed', hasOpenPanel ? 'true' : 'false');
  }

  elements.detailsTitle.textContent = titles[openPanel] || 'Details';
}

/** 渲染会话历史列表和预览 */
function renderHistory(state) {
  const entries = Array.isArray(state.sessionHistory) ? state.sessionHistory : [];
  const preview = state.historyPreview;

  elements.historyDrawer.classList.toggle('hidden', !uiState.historyOpen);
  elements.historyButton.setAttribute('aria-pressed', uiState.historyOpen ? 'true' : 'false');

  if (!uiState.historyOpen) return;

  if (entries.length === 0) {
    elements.historyList.innerHTML = '<div class="history-empty">No archived sessions yet.</div>';
  } else {
    elements.historyList.innerHTML = entries.map(entry => `
      <button class="history-item${preview?.id === entry.id ? ' history-item--active' : ''}" data-history-id="${escapeHtml(entry.id)}" type="button">
        <strong>${escapeHtml(entry.title)}</strong>
        <span>${escapeHtml(entry.preview || '')}</span>
        <small>${escapeHtml(formatDateTime(entry.updatedAt))}</small>
      </button>
    `).join('');
  }

  if (!preview) {
    elements.historyPreview.innerHTML = '<div class="history-empty">Select a previous session to preview it here.</div>';
    return;
  }

  elements.historyPreview.innerHTML = `
    <div class="history-preview-header">
      <strong>${escapeHtml(preview.title)}</strong>
      <span>${escapeHtml([preview.model, preview.cwd].filter(Boolean).join(' • '))}</span>
      <button class="secondary secondary--small" id="restoreSessionButton" data-restore-id="${escapeHtml(preview.id)}" type="button">Restore</button>
    </div>
    <div class="history-preview-body">
      ${preview.messages.map(message => `
        <article class="message message--${escapeHtml(message.role)} message--tone-${escapeHtml(message.tone || message.role)} message--history">
          <div class="message-meta">
            <span>${escapeHtml(message.role === 'user' ? 'You' : 'MAGI')}</span>
            <span>${escapeHtml(formatTimestamp(message.timestamp))}</span>
          </div>
          <div class="message-body">${renderMessageBody(message)}</div>
        </article>
      `).join('')}
    </div>
  `;
}

/** 渲染欢迎页面 */
function renderWelcome(state) {
  const hasMessages = Array.isArray(state.messages) && state.messages.length > 0;
  elements.welcomeCard.classList.toggle('hidden', hasMessages);
  elements.shell.classList.toggle('shell--conversation', hasMessages);

  const selectedProfile = getSelectedProfile(state);
  const runtimeModel = state.runtime?.model || state.selectedModel || 'default';
  const modelLabel = selectedProfile?.label || runtimeModel;
  const contextSuffix = state.ideContextEnabled ? ' IDE context on.' : ' IDE context off.';
  const statusText =
    state.backendStatus === 'online'
      ? `Ready in ${basename(state.cwd || 'workspace')} with ${modelLabel}.${contextSuffix}`
      : state.backendStatus === 'starting'
        ? 'Connecting MAGI...'
        : 'Start a conversation below.';
  elements.welcomeNote.textContent = statusText;

  // Login overlay: show when Claude model switch failed OR login in progress
  // This is a full overlay — not blocked by hasMessages
  const showLogin = Boolean(state.pendingLoginForModel) || Boolean(state.loginInProgress);

  if (elements.loginScreen) {
    elements.loginScreen.classList.toggle('hidden', !showLogin);
  }
  if (elements.loginError && showLogin) {
    const errMsg = state.lastError || '';
    elements.loginError.classList.toggle('hidden', !errMsg);
    elements.loginError.textContent = errMsg;
  }
  if (elements.loginClaudeAi) elements.loginClaudeAi.disabled = Boolean(state.loginInProgress);
  if (elements.loginConsole) elements.loginConsole.disabled = Boolean(state.loginInProgress);
}


/** 同步输入框和按钮的禁用/启用状态 */
function syncComposerState(state) {
  const blocked = Boolean(state.pendingPermission) || Boolean(state.busy);
  if (elements.newSessionButton) elements.newSessionButton.disabled = state.backendStatus === 'starting';
  if (elements.planModeToggleButton) elements.planModeToggleButton.disabled = blocked || state.backendStatus === 'starting';
  if (elements.ideContextToggleButton) elements.ideContextToggleButton.disabled = false;
  if (elements.panelToggleButton) elements.panelToggleButton.disabled = false;
  if (elements.modelSelect) {
    elements.modelSelect.disabled = blocked || Boolean(state.pendingModelValue) || elements.modelSelect.options.length === 0;
  }
  if (elements.thinkingSelect) {
    elements.thinkingSelect.disabled = blocked || Boolean(state.pendingThinkingMode);
  }
  elements.promptInput.disabled = Boolean(state.pendingPermission);
  elements.promptInput.placeholder = state.pendingPermission
    ? 'Approve or deny the pending request before sending another prompt...'
    : state.busy
      ? 'MAGI is processing the current turn...'
      : 'Ask MAGI to inspect code, explain a file, or make a change (type / for commands)...';
  updateComposerDraftState(state);
}

/* ============================================================
 * 十五、主渲染函数
 * 由 extension.js 推送的 state 更新触发
 * 调用所有子渲染函数刷新整个 UI
 * ============================================================ */
function render(state) {
  currentState = state;
  renderSessionMeta(state);
  renderModelPicker(state);
  renderInteractionControls(state);
  renderRateLimit(state);
  renderPermission(state);
  renderContext(state);
  renderFacts(state);
  renderActivity(state);
  renderMcpPanel(state);       // MCP 服务器面板
  renderToolsPanel(state);     // 工具控制面板
  renderTodosPanel(state);     // 任务/Agent 面板
  renderUsagePanel(state);     // Usage 面板
  renderHistory(state);
  renderWelcome(state);

  renderTranscript(state);
  renderSessionTabs(state);    // 多会话标签栏
  applyDetailsVisibility();
  syncComposerState(state);
}

/* ============================================================
 * 十六、提交 Prompt
 * 用户按下 Send 按钮或 Enter 键时触发
 * ============================================================ */
/** Pending file attachments */
let pendingAttachments = [];

/** Supported file types */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const PDF_TYPE = 'application/pdf';

function classifyFile(mimeType, name) {
  if (IMAGE_TYPES.includes(mimeType)) return 'image';
  if (mimeType === PDF_TYPE) return 'document';
  const ext = (name || '').split('.').pop()?.toLowerCase();
  const textExts = new Set([
    'js','ts','jsx','tsx','py','go','rs','java','c','cpp','h','hpp','cs','rb','php',
    'swift','kt','scala','sh','bash','zsh','fish','ps1','bat','cmd','sql','graphql',
    'json','yaml','yml','toml','xml','html','css','scss','less','md','txt','csv',
    'log','ini','cfg','conf','env','gitignore','dockerfile','makefile',
  ]);
  if (textExts.has(ext)) return 'document';
  return null;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * 根据当前模型返回图片最大像素尺寸
 * 不同模型 API 对图片大小有不同限制
 */
function getModelImageMaxDim() {
  // CLI 后端 (imageResizer.ts) 硬限制 IMAGE_MAX_WIDTH/HEIGHT = 2000
  // 且 sharp 原生模块可能不可用，超过此尺寸会导致后端崩溃
  // 所以所有模型统一限制到 2000 以内
  const model = (currentState?.runtime?.model || currentState?.selectedModel || '').toLowerCase();
  // MiniMax 系列：更保守的限制
  if (model.includes('minimax') || model.includes('m2.7')) {
    return 1920;
  }
  // 所有其他模型统一 2000（CLI 后端硬限制）
  return 2000;
}

/**
 * 用 Canvas 缩放图片，确保不超过 maxDim x maxDim，
 * 且 base64 大小不超过 5MB（CLI 后端 API_IMAGE_MAX_BASE64_SIZE）
 */
const MAX_BASE64_SIZE = 5 * 1024 * 1024; // 5MB
function resizeImageDataUrl(dataUrl, maxDim) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const needsResize = width > maxDim || height > maxDim;
      if (needsResize) {
        const scale = Math.min(maxDim / width, maxDim / height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      // 先尝试 PNG
      let result = canvas.toDataURL('image/png');
      // 如果 base64 部分超过 5MB，改用 JPEG 逐步降低质量
      const getBase64Len = (du) => {
        const idx = du.indexOf(',');
        return idx >= 0 ? du.length - idx - 1 : du.length;
      };
      if (getBase64Len(result) > MAX_BASE64_SIZE) {
        for (const q of [0.85, 0.7, 0.5, 0.3]) {
          result = canvas.toDataURL('image/jpeg', q);
          if (getBase64Len(result) <= MAX_BASE64_SIZE) break;
        }
      }
      resolve(result);
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function handleFileSelection(files) {
  for (const file of Array.from(files)) {
    const type = classifyFile(file.type, file.name);
    if (!type) continue;
    try {
      let dataUrl = await readFileAsDataUrl(file);
      // 根据当前模型的限制自动缩放图片
      if (type === 'image') {
        dataUrl = await resizeImageDataUrl(dataUrl, getModelImageMaxDim());
      }
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) continue;
      pendingAttachments.push({
        name: file.name,
        type,
        mediaType: match[1],
        data: match[2],
        previewUrl: type === 'image' ? dataUrl : null,
      });
    } catch (e) { /* skip */ }
  }
  renderAttachmentPreview();
}

function renderAttachmentPreview() {
  if (!elements.attachmentsPreview) return;
  if (pendingAttachments.length === 0) {
    elements.attachmentsPreview.classList.add('hidden');
    elements.attachmentsPreview.innerHTML = '';
    return;
  }
  elements.attachmentsPreview.classList.remove('hidden');
  elements.attachmentsPreview.innerHTML = pendingAttachments.map((att, i) => {
    const preview = att.previewUrl
      ? `<img src="${att.previewUrl}" class="attachment-thumb" alt="${escapeHtml(att.name)}" />`
      : `<span class="attachment-icon">📄</span>`;
    return `<div class="attachment-chip" data-index="${i}">
      ${preview}
      <span class="attachment-name">${escapeHtml(att.name)}</span>
      <button class="attachment-remove" data-index="${i}" type="button">&times;</button>
    </div>`;
  }).join('');

  // Bind remove buttons
  elements.attachmentsPreview.querySelectorAll('.attachment-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      pendingAttachments.splice(idx, 1);
      renderAttachmentPreview();
    });
  });
}

function sendPrompt() {
  const text = elements.promptInput.value.trim();
  if (!text && pendingAttachments.length === 0) return;

  hideSlashPopup();

  pendingPromptText = text;
  uiState.optimisticUserText = text;
  uiState.optimisticUserTimestamp = new Date().toISOString();

  // 存图片到 webview 本地 Map（不经过 extension.js 往返）
  const imagePreviewUrls = pendingAttachments
    .filter(a => a.previewUrl)
    .map(a => a.previewUrl);
  const msgKey = text || '(see attached files)';
  if (imagePreviewUrls.length > 0) {
    sentImagesMap.set(msgKey, imagePreviewUrls);
  }

  if (currentState) render(currentState);

  const msg = { type: 'sendPrompt', text: text || '(see attached files)' };
  if (pendingAttachments.length > 0) {
    msg.attachments = pendingAttachments.map(a => ({
      name: a.name, type: a.type, mediaType: a.mediaType, data: a.data,
    }));
  }
  vscode.postMessage(msg);
  pendingAttachments = [];
  renderAttachmentPreview();
}

/* ============================================================
 * 十七、事件绑定
 * 绑定所有 UI 控件的交互事件
 * ============================================================ */

// ── 发送、停止和权限按钮 ──
bindEvent(elements.sendButton, 'click', sendPrompt);
bindEvent(elements.stopButton, 'click', () => {
  vscode.postMessage({ type: 'stopGeneration' });
});
bindEvent(elements.approveButton, 'click', () => {
  vscode.postMessage({ type: 'permissionDecision', allow: true });
});
bindEvent(elements.denyButton, 'click', () => {
  vscode.postMessage({ type: 'permissionDecision', allow: false });
});

// ── 模型选择器 ──
bindEvent(elements.modelSelect, 'change', () => {
  vscode.postMessage({ type: 'selectModel', value: elements.modelSelect.value });
});

// ── Thinking 模式选择器 ──
bindEvent(elements.thinkingSelect, 'change', () => {
  vscode.postMessage({ type: 'selectThinkingMode', value: elements.thinkingSelect.value });
});

// ── 权限模式选择器 ──
bindEvent(elements.permissionSelect, 'change', () => {
  vscode.postMessage({ type: 'selectPermissionMode', value: elements.permissionSelect.value });
});

// ── Plan 模式切换 ──
bindEvent(elements.planModeToggleButton, 'click', () => {
  const enabled = elements.planModeToggleButton.getAttribute('aria-pressed') !== 'true';
  if (currentState) {
    currentState = { ...currentState, planModeEnabled: enabled };
    render(currentState);
  }
  vscode.postMessage({ type: 'togglePlanMode', enabled });
});

// ── IDE Context 切换 ──
bindEvent(elements.ideContextToggleButton, 'click', () => {
  const enabled = elements.ideContextToggleButton.getAttribute('aria-pressed') !== 'true';
  if (currentState) {
    currentState = { ...currentState, ideContextEnabled: enabled };
    render(currentState);
  }
  vscode.postMessage({ type: 'toggleIdeContext', enabled });
});

// ── 设置按钮 ──
bindEvent(elements.openSettingsButton, 'click', () => {
  vscode.postMessage({ type: 'openModelSettings' });
});

// ── 新会话按钮 ──
// ── 登录按钮（Claude Code 风格，两种方式） ──
bindEvent(elements.loginClaudeAi, 'click', () => {
  vscode.postMessage({ type: 'login', method: 'claudeai' });
});
bindEvent(elements.loginConsole, 'click', () => {
  vscode.postMessage({ type: 'login', method: 'console' });
});
bindEvent(elements.loginCancel, 'click', () => {
  vscode.postMessage({ type: 'loginCancel' });
});

// ── 附件按钮 ──
bindEvent(elements.attachButton, 'click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = () => {
    if (input.files && input.files.length > 0) handleFileSelection(input.files);
  };
  input.click();
});

// ── 粘贴图片 ──
bindEvent(elements.promptInput, 'paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  const files = [];
  for (const item of items) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length > 0) {
    e.preventDefault();
    handleFileSelection(files);
  }
});

// ── 新会话按钮 ──
bindEvent(elements.newSessionButton, 'click', () => {
  uiState.historyOpen = false;
  elements.historyDrawer.classList.add('hidden');
  elements.historyButton.setAttribute('aria-pressed', 'false');
  vscode.postMessage({ type: 'newSession' });
});

// ── 历史记录按钮 ──
bindEvent(elements.historyButton, 'click', () => {
  uiState.openPanel = null;
  applyDetailsVisibility();
  uiState.historyOpen = !uiState.historyOpen;
  if (!uiState.historyOpen) vscode.postMessage({ type: 'clearHistoryPreview' });
  elements.historyDrawer.classList.toggle('hidden', !uiState.historyOpen);
  elements.historyButton.setAttribute('aria-pressed', uiState.historyOpen ? 'true' : 'false');
  if (uiState.historyOpen && currentState) renderHistory(currentState);
});

// ── 关闭历史抽屉 ──
bindEvent(elements.closeHistoryButton, 'click', () => {
  uiState.historyOpen = false;
  elements.historyDrawer.classList.add('hidden');
  elements.historyButton.setAttribute('aria-pressed', 'false');
  vscode.postMessage({ type: 'clearHistoryPreview' });
});

// ── 关闭详情抽屉 ──
bindEvent(elements.closeDetailsButton, 'click', () => {
  uiState.openPanel = null;
  applyDetailsVisibility();
});

// ── Panels 切换按钮 ──
bindEvent(elements.panelToggleButton, 'click', () => {
  uiState.historyOpen = false;
  elements.historyDrawer.classList.add('hidden');
  elements.historyButton.setAttribute('aria-pressed', 'false');
  vscode.postMessage({ type: 'clearHistoryPreview' });
  uiState.openPanel = uiState.openPanel ? null : uiState.lastPanel || 'context';
  applyDetailsVisibility();
});

// ── 详情面板标签切换 ──
detailButtons.forEach(button => {
  button.addEventListener('click', () => {
    uiState.historyOpen = false;
    elements.historyDrawer.classList.add('hidden');
    elements.historyButton.setAttribute('aria-pressed', 'false');
    vscode.postMessage({ type: 'clearHistoryPreview' });
    const nextPanel = button.dataset.panel;
    uiState.openPanel = nextPanel;
    uiState.lastPanel = nextPanel;
    applyDetailsVisibility();
    // 切换面板时重新渲染对应内容
    if (currentState) {
      if (nextPanel === 'mcp') renderMcpPanel(currentState);
      if (nextPanel === 'tools') renderToolsPanel(currentState);
      if (nextPanel === 'todos') renderTodosPanel(currentState);
      if (nextPanel === 'usage') {
        renderUsagePanel(currentState);
        vscode.postMessage({ type: 'requestUsage' });
      }
    }
  });
});

// ── 历史列表点击 ──
bindEvent(elements.historyList, 'click', event => {
  const button = event.target.closest('[data-history-id]');
  if (!button) return;
  vscode.postMessage({ type: 'openHistoryEntry', id: button.getAttribute('data-history-id') });
});

// ── 历史预览恢复按钮 ──
bindEvent(elements.historyPreview, 'click', event => {
  const restoreBtn = event.target.closest('[data-restore-id]');
  if (!restoreBtn) return;
  vscode.postMessage({ type: 'restoreHistoryEntry', id: restoreBtn.getAttribute('data-restore-id') });
  uiState.historyOpen = false;
});

// ── 输入框键盘事件 ──
bindEvent(elements.promptInput, 'keydown', event => {
  // Enter 发送（Shift+Enter 换行）
  if (event.key === 'Enter' && !event.shiftKey && !isPromptComposing && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    if (canSubmitPrompt()) sendPrompt();
  }
  // Escape 关闭 slash 弹出
  if (event.key === 'Escape' && uiState.slashPopupVisible) {
    hideSlashPopup();
    event.preventDefault();
  }
  // Tab 选择 slash 命令
  if (event.key === 'Tab' && uiState.slashPopupVisible) {
    event.preventDefault();
    const firstItem = elements.slashPopup?.querySelector('.slash-item');
    if (firstItem) {
      elements.promptInput.value = firstItem.getAttribute('data-slash-cmd') + ' ';
      hideSlashPopup();
      autoSizePromptInput();
      updateComposerDraftState();
    }
  }
});

// ── 输入法组合状态追踪 ──
bindEvent(elements.promptInput, 'compositionstart', () => { isPromptComposing = true; });
bindEvent(elements.promptInput, 'compositionend', () => {
  isPromptComposing = false;
  autoSizePromptInput();
  updateComposerDraftState();
});

// ── 输入框内容变化 ──
bindEvent(elements.promptInput, 'input', () => {
  autoSizePromptInput();
  updateComposerDraftState();
  // Slash 命令自动补全：检测 / 开头
  const text = elements.promptInput.value;
  if (text.startsWith('/')) {
    const filterText = text.slice(1).split(/\s/)[0]; // 只取 / 后面第一个单词
    if (!text.includes(' ')) {
      // 还没输完命令，显示补全
      renderSlashPopup(filterText);
    } else {
      hideSlashPopup();
    }
  } else {
    hideSlashPopup();
  }
});

// ── Slash 命令弹出框点击选择 ──
bindEvent(elements.slashPopup, 'click', event => {
  const item = event.target.closest('[data-slash-cmd]');
  if (!item) return;
  elements.promptInput.value = item.getAttribute('data-slash-cmd') + ' ';
  hideSlashPopup();
  elements.promptInput.focus();
  autoSizePromptInput();
  updateComposerDraftState();
});

// ── 工具控制面板事件委托 ──
bindEvent(elements.toolsPanel, 'change', event => {
  const checkbox = event.target.closest('.tool-checkbox');
  if (!checkbox) return;
  const toolName = checkbox.getAttribute('data-tool-name');
  const allowed = checkbox.checked;
  // 通知 extension.js 更新工具允许/拒绝状态
  vscode.postMessage({ type: 'updateToolPermission', toolName, allowed });
});

bindEvent(elements.toolsPanel, 'click', event => {
  if (event.target.id === 'resetToolsBtn') {
    vscode.postMessage({ type: 'resetToolPermissions' });
  }
});

// ── 多会话标签栏事件委托 ──
bindEvent(elements.sessionTabs, 'click', event => {
  // 关闭会话
  const closeBtn = event.target.closest('[data-close-session]');
  if (closeBtn) {
    vscode.postMessage({ type: 'closeSession', id: closeBtn.getAttribute('data-close-session') });
    return;
  }
  // 添加新会话
  if (event.target.id === 'addSessionBtn' || event.target.closest('#addSessionBtn')) {
    vscode.postMessage({ type: 'addParallelSession' });
    return;
  }
  // 切换会话
  const tab = event.target.closest('[data-session-id]');
  if (tab) {
    vscode.postMessage({ type: 'switchSession', id: tab.getAttribute('data-session-id') });
  }
});

/* ============================================================
 * 点击空白处关闭历史抽屉 / 详情面板
 * ============================================================ */
document.addEventListener('click', event => {
  const target = event.target;
  // 历史抽屉：点击外部关闭
  if (uiState.historyOpen) {
    const insideHistory = elements.historyDrawer?.contains(target) || elements.historyButton?.contains(target);
    if (!insideHistory) {
      uiState.historyOpen = false;
      elements.historyDrawer.classList.add('hidden');
      elements.historyButton.setAttribute('aria-pressed', 'false');
      vscode.postMessage({ type: 'clearHistoryPreview' });
    }
  }
  // 详情面板：点击外部关闭
  if (uiState.openPanel) {
    const insideDetails =
      elements.detailsDrawer?.contains(target) ||
      elements.panelToggleButton?.contains(target) ||
      target.closest?.('[data-panel]');
    if (!insideDetails) {
      uiState.openPanel = null;
      applyDetailsVisibility();
    }
  }
});

/* ============================================================
 * 十八、消息接收处理
 * 监听 extension.js 发来的消息并响应
 * ============================================================ */
window.addEventListener('message', event => {
  const message = event.data;
  if (!message) return;

  // 全量状态更新
  if (message.type === 'state') {
    render(message.state);
    return;
  }

  // Prompt 提交结果回调
  if (message.type === 'promptSubmission') {
    const accepted = Boolean(message.result?.accepted);
    if (accepted) {
      elements.promptInput.value = '';
      pendingPromptText = '';
      autoSizePromptInput();
      updateComposerDraftState();
      return;
    }
    if (!elements.promptInput.value.trim() && pendingPromptText) {
      elements.promptInput.value = pendingPromptText;
      autoSizePromptInput();
    }
    uiState.optimisticUserText = '';
    uiState.optimisticUserTimestamp = '';
    pendingPromptText = '';
    if (currentState) render(currentState);
    else updateComposerDraftState();
    return;
  }

  // 输入框聚焦请求
  if (message.type === 'focusInput') {
    elements.promptInput.focus();
    vscode.postMessage({ type: 'focusInputAck' });
  }
  if (message.type === 'insertText') {
    const input = elements.promptInput;
    const start = input.selectionStart || input.value.length;
    const end = input.selectionEnd || start;
    input.value = input.value.slice(0, start) + message.text + input.value.slice(end);
    input.selectionStart = input.selectionEnd = start + message.text.length;
    input.focus();
    autoSizePromptInput();
    updateComposerDraftState();
  }
});

/* ============================================================
 * 十九、初始化
 * ============================================================ */
autoSizePromptInput();
updateComposerDraftState();
// 通知 extension.js webview 已就绪
vscode.postMessage({ type: 'ready' });

console.log('[NERV-DEBUG] app.js fully loaded, sendButton:', elements.sendButton, 'disabled:', elements.sendButton?.disabled);
