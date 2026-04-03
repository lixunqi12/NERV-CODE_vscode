const vscode = acquireVsCodeApi();

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
};

const detailButtons = Array.from(document.querySelectorAll('.details-tabs [data-panel]'));

const uiState = {
  openPanel: null,
  lastPanel: 'context',
  historyOpen: false,
  lastMessageCount: 0,
  lastStreamingTextLength: 0,
  optimisticUserText: '',
  optimisticUserTimestamp: '',
};

let currentState = null;
let isPromptComposing = false;
let pendingPromptText = '';

const BRAILLE_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let brailleSpinnerFrame = 0;

function tickBrailleSpinners() {
  const frame = BRAILLE_SPINNER_FRAMES[brailleSpinnerFrame % BRAILLE_SPINNER_FRAMES.length];
  document.querySelectorAll('[data-braille-spinner]').forEach(element => {
    element.textContent = frame;
  });
  brailleSpinnerFrame += 1;
}

window.setInterval(tickBrailleSpinners, 90);

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shortSessionId(value) {
  if (!value) {
    return 'Awaiting session';
  }
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function basename(value) {
  if (!value) {
    return 'unknown';
  }
  return String(value).split(/[\\/]/).pop() || value;
}

function formatTimestamp(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDateTime(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatUsd(value) {
  if (typeof value !== 'number') {
    return 'n/a';
  }
  return `$${value.toFixed(4)}`;
}

function formatResetTime(rateLimit) {
  if (!rateLimit || typeof rateLimit.resetsAt !== 'number') {
    return '';
  }
  const date = new Date(rateLimit.resetsAt * 1000);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString([], {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function truncateInlineText(value, limit = 140) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function getSelectedProfile(state) {
  return (state.modelProfiles || []).find(profile => profile.id === state.activeProfileId) || null;
}

function getSelectedModelInfo(state) {
  return (state.availableModels || []).find(model => model.value === state.selectedModel) || null;
}

function findModelOption(selectElement, value) {
  if (!selectElement || typeof value !== 'string' || !value) {
    return null;
  }
  return Array.from(selectElement.options).find(option => option.value === value) || null;
}

function autoSizePromptInput() {
  elements.promptInput.style.height = 'auto';
  elements.promptInput.style.height = `${Math.min(elements.promptInput.scrollHeight, 120)}px`;
}

function updateComposerDraftState(state = currentState || {}) {
  const hasText = elements.promptInput.value.trim().length > 0;
  const blocked = Boolean(state.pendingPermission) || Boolean(state.busy);
  elements.composer.classList.toggle('composer--has-input', hasText);
  elements.composer.classList.toggle('composer--empty', !hasText);
  elements.sendButton.disabled = blocked || !hasText;
}

function bindEvent(element, eventName, handler) {
  if (!element) {
    return;
  }
  element.addEventListener(eventName, handler);
}

function canSubmitPrompt() {
  return Boolean(
    currentState &&
      !currentState.pendingPermission &&
      !currentState.busy &&
      elements.promptInput.value.trim(),
  );
}

function renderSessionMeta(state) {
  const selectedProfile = getSelectedProfile(state);
  const runtimeModel = state.runtime?.model || state.selectedModel || 'default';
  const meta = [basename(state.cwd || 'Workspace')];
  const interaction = state.interactionStatus;

  if (state.sessionState && state.sessionState !== 'idle') {
    meta.push(state.sessionState);
  }
  if (runtimeModel) {
    meta.push(runtimeModel);
  }
  if (selectedProfile) {
    meta.push(selectedProfile.label);
  }

  const metaMarkup = meta.map(part => escapeHtml(part)).join(' <span class="meta-sep">•</span> ');
  const rateLimitSummary = formatRateLimitSummary(state.rateLimit);
  let tone = 'normal';
  let markup = metaMarkup;
  let title = meta.join(' • ');

  if (state.pendingPermission) {
    tone = 'warn';
    markup =
      'Approval required <span class="meta-sep">•</span> review the pending tool request';
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
    markup = `Reply blocked <span class="meta-sep">•</span> ${escapeHtml(
      truncateInlineText(rateLimitSummary || 'Usage limit reached.', 120),
    )}`;
    title = rateLimitSummary || 'Usage limit reached.';
  } else if (state.lastError) {
    tone = 'error';
    markup = `Reply failed <span class="meta-sep">•</span> ${escapeHtml(
      truncateInlineText(state.lastError, 140),
    )}`;
    title = state.lastError;
  } else if (interaction?.status === 'success') {
    markup = escapeHtml(interaction.message || title);
    title = interaction.message || title;
  }

  elements.sessionMeta.classList.remove(
    'composer-hint--busy',
    'composer-hint--warn',
    'composer-hint--error',
  );
  if (tone === 'busy') {
    elements.sessionMeta.classList.add('composer-hint--busy');
  } else if (tone === 'warn') {
    elements.sessionMeta.classList.add('composer-hint--warn');
  } else if (tone === 'error') {
    elements.sessionMeta.classList.add('composer-hint--error');
  }

  elements.sessionMeta.innerHTML = markup;
  elements.sessionMeta.title = title;
}

function renderModelPicker(state) {
  const profiles = Array.isArray(state.modelProfiles) ? state.modelProfiles : [];
  const availableModels = Array.isArray(state.availableModels) ? state.availableModels : [];
  const profileOptions = profiles.map(profile => ({
    value: profile.id,
    label:
      state.defaultProfileId && profile.id === state.defaultProfileId
        ? `${profile.label} (default)`
        : profile.label,
    description: profile.description || profile.model,
  }));
  const modelOptions = availableModels.map(model => ({
    value: model.value,
    label: model.displayName || model.value,
    description: model.description || model.value,
  }))
  .filter(option => !(profileOptions.length > 0 && option.value === 'default'));

  if (profileOptions.length === 0 && modelOptions.length === 0) {
    modelOptions.push({
      value: state.selectedModel || 'default',
      label: state.selectedModel || 'default',
      description: 'Waiting for backend model metadata.',
    });
  }

  const allOptions = [...profileOptions, ...modelOptions];
  const hasSelectedModelOption = modelOptions.some(option => option.value === state.selectedModel);
  const currentValue =
    state.pendingModelValue ||
    state.activeProfileId ||
    profileOptions[0]?.value ||
    (hasSelectedModelOption ? state.selectedModel : '') ||
    modelOptions[0]?.value ||
    '';

  elements.modelSelect.innerHTML = allOptions
    .map(
      option => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`,
    )
    .join('');
  const availableValues = Array.from(elements.modelSelect.options).map(option => option.value);
  const resolvedValue =
    availableValues.includes(currentValue)
      ? currentValue
      : availableValues[0] || '';
  if (resolvedValue) {
    elements.modelSelect.value = resolvedValue;
  }

  const selectedOption =
    allOptions.find(option => option.value === elements.modelSelect.value) || allOptions[0];
  const selectedProfile =
    profiles.find(profile => profile.id === elements.modelSelect.value) || getSelectedProfile(state);
  const selectedModel =
    availableModels.find(model => model.value === elements.modelSelect.value) || getSelectedModelInfo(state);
  const usingProfile = Boolean(selectedProfile && selectedProfile.id === elements.modelSelect.value);

  elements.modelSelect.title = usingProfile
    ? selectedProfile.description || 'Profile route'
    : selectedModel?.description || selectedOption?.description || 'Runtime model';
}

function renderInteractionControls(state) {
  const pendingThinking = state.pendingThinkingMode || state.thinkingMode || 'adaptive';
  if (findModelOption(elements.thinkingSelect, pendingThinking)) {
    elements.thinkingSelect.value = pendingThinking;
  } else {
    elements.thinkingSelect.value = 'adaptive';
  }
  elements.thinkingSelect.title =
    elements.thinkingSelect.options[elements.thinkingSelect.selectedIndex]?.textContent ||
    'Thinking mode';
  elements.modelSelect.parentElement.classList.toggle('chip-select--pending', Boolean(state.pendingModelValue));
  elements.thinkingSelect.parentElement.classList.toggle(
    'chip-select--pending',
    Boolean(state.pendingThinkingMode),
  );
  elements.planModeToggleButton.classList.toggle('chip--active', Boolean(state.planModeEnabled));
  elements.planModeToggleButton.setAttribute(
    'aria-pressed',
    state.planModeEnabled ? 'true' : 'false',
  );
  elements.ideContextToggleButton.classList.toggle(
    'chip--active',
    Boolean(state.ideContextEnabled),
  );
  elements.ideContextToggleButton.setAttribute(
    'aria-pressed',
    state.ideContextEnabled ? 'true' : 'false',
  );
  if (elements.panelToggleButton) {
    elements.panelToggleButton.classList.toggle('chip--active', Boolean(uiState.openPanel));
    elements.panelToggleButton.setAttribute('aria-pressed', uiState.openPanel ? 'true' : 'false');
  }
}

function renderRateLimit(state) {
  if (!state.rateLimit) {
    elements.rateLimit.classList.add('hidden');
    elements.rateLimit.innerHTML = '';
    return;
  }

  const resetTime = formatResetTime(state.rateLimit);
  const details = [state.rateLimit.rateLimitType, resetTime ? `resets ${resetTime}` : '']
    .filter(Boolean)
    .join(' - ');

  elements.rateLimit.classList.remove('hidden');
  elements.rateLimit.innerHTML = `
    <strong>${escapeHtml(state.rateLimit.status === 'rejected' ? 'Usage limit reached' : 'Usage notice')}</strong>
    <span>${escapeHtml(details || 'NERV CODE reported a usage update.')}</span>
  `;
}

function renderPermission(state) {
  const pending = state.pendingPermission;
  if (!pending) {
    elements.permissionCard.classList.add('hidden');
    return;
  }

  elements.permissionCard.classList.remove('hidden');
  elements.permissionTitle.textContent = pending.title || pending.toolName || 'Authorization request';
  elements.permissionDescription.textContent =
    pending.description || `MAGI requests approval to use ${pending.toolName}.`;
  elements.permissionInput.textContent = JSON.stringify(pending.input || {}, null, 2);
}

function renderTranscript(state) {
  const messages = Array.isArray(state.messages) ? state.messages : [];
  const streamingText =
    typeof state.streamingAssistantText === 'string' ? state.streamingAssistantText : '';
  const optimisticCommitted = Boolean(
    uiState.optimisticUserText &&
      messages.some(
        message => message.role === 'user' && message.text.trim() === uiState.optimisticUserText,
      ),
  );
  if (optimisticCommitted) {
    uiState.optimisticUserText = '';
    uiState.optimisticUserTimestamp = '';
  }
  const hasStreamingText = streamingText.length > 0;
  const showThinkingBubble =
    Boolean(state.busy) &&
    state.sessionState === 'running' &&
    !state.pendingPermission &&
    state.backendStatus === 'online' &&
    !hasStreamingText;
  const showStreamingBubble =
    Boolean(state.busy) &&
    state.sessionState === 'running' &&
    !state.pendingPermission &&
    state.backendStatus === 'online' &&
    hasStreamingText;
  const previousMessageCount = uiState.lastMessageCount;
  const stickToBottom =
    elements.transcript.scrollHeight -
      elements.transcript.scrollTop -
      elements.transcript.clientHeight <
      40 ||
    messages.length > previousMessageCount ||
    streamingText.length !== uiState.lastStreamingTextLength ||
    showThinkingBubble;

  if (messages.length === 0) {
    if (uiState.optimisticUserText) {
      elements.transcript.innerHTML = `
          <article class="message message--user message--pending">
            <div class="message-meta">
              <span>You</span>
              <span>${escapeHtml(formatTimestamp(uiState.optimisticUserTimestamp))}</span>
            </div>
            <div class="message-body">${escapeHtml(uiState.optimisticUserText).replace(/\n/g, '<br>')}</div>
          </article>
        `;
      if (showThinkingBubble) {
        elements.transcript.innerHTML += `
          <article class="message message--assistant message--placeholder">
            <div class="message-meta">
              <span>MAGI</span>
              <span>thinking</span>
            </div>
            <div class="message-body message-body--placeholder">
              <span class="braille-spinner" data-braille-spinner aria-hidden="true">â ‹</span>
              <span>Thinking...</span>
            </div>
          </article>
        `;
      } else if (showStreamingBubble) {
        elements.transcript.innerHTML += `
          <article class="message message--assistant message--streaming">
            <div class="message-meta">
              <span>MAGI</span>
              <span>streaming</span>
            </div>
            <div class="message-body">${escapeHtml(streamingText).replace(/\n/g, '<br>')}</div>
          </article>
        `;
      }
    } else if (showStreamingBubble) {
      elements.transcript.innerHTML = `
          <article class="message message--assistant message--streaming">
            <div class="message-meta">
              <span>MAGI</span>
              <span>streaming</span>
            </div>
            <div class="message-body">${escapeHtml(streamingText).replace(/\n/g, '<br>')}</div>
          </article>
        `;
    } else if (showThinkingBubble) {
      elements.transcript.innerHTML = `
          <article class="message message--assistant message--placeholder">
            <div class="message-meta">
              <span>MAGI</span>
              <span>thinking</span>
            </div>
            <div class="message-body message-body--placeholder">
              <span class="braille-spinner" data-braille-spinner aria-hidden="true">⠋</span>
              <span>Thinking...</span>
            </div>
          </article>
        `;
    } else {
      elements.transcript.innerHTML = '<div class="transcript-empty"></div>';
    }
  } else {
    const transcriptMarkup = messages
      .map(message => {
        const speaker = message.role === 'user' ? 'You' : 'MAGI';
        return `
          <article class="message message--${escapeHtml(message.role)} message--tone-${escapeHtml(message.tone || message.role)}">
            <div class="message-meta">
              <span>${escapeHtml(speaker)}</span>
              <span>${escapeHtml(formatTimestamp(message.timestamp))}</span>
            </div>
            <div class="message-body">${escapeHtml(message.text).replace(/\n/g, '<br>')}</div>
          </article>
        `;
      })
      .join('');

    const optimisticMarkup = uiState.optimisticUserText
      ? `
          <article class="message message--user message--pending">
            <div class="message-meta">
              <span>You</span>
              <span>${escapeHtml(formatTimestamp(uiState.optimisticUserTimestamp))}</span>
            </div>
            <div class="message-body">${escapeHtml(uiState.optimisticUserText).replace(/\n/g, '<br>')}</div>
          </article>`
      : '';

    if (showStreamingBubble) {
      elements.transcript.innerHTML = `${transcriptMarkup}${optimisticMarkup}
          <article class="message message--assistant message--streaming">
            <div class="message-meta">
              <span>MAGI</span>
              <span>streaming</span>
            </div>
            <div class="message-body">${escapeHtml(streamingText).replace(/\n/g, '<br>')}</div>
          </article>`;
    } else if (showThinkingBubble) {
      elements.transcript.innerHTML = `${transcriptMarkup}${optimisticMarkup}
          <article class="message message--assistant message--placeholder">
            <div class="message-meta">
              <span>MAGI</span>
              <span>thinking</span>
            </div>
            <div class="message-body message-body--placeholder">
              <span class="braille-spinner" data-braille-spinner aria-hidden="true">⠋</span>
              <span>Thinking...</span>
            </div>
          </article>`;
    } else {
      elements.transcript.innerHTML = `${transcriptMarkup}${optimisticMarkup}`;
    }
  }

  if (stickToBottom) {
    elements.transcript.scrollTop = elements.transcript.scrollHeight;
  }

  uiState.lastMessageCount = messages.length;
  uiState.lastStreamingTextLength = streamingText.length;
  tickBrailleSpinners();
}

function renderContext(state) {
  const active = state.ideContext?.activeEditor;
  const workspace = state.ideContext?.workspace;
  const visibleEditors = state.ideContext?.visibleEditors || [];

  const rows = [
    ['Active File', active?.path || 'none'],
    ['Language', active?.language || 'n/a'],
    ['Cursor', active ? `L${active.cursorLine}:C${active.cursorColumn}` : 'n/a'],
    [
      'Selection',
      active?.selection
        ? `L${active.selection.startLine}-${active.selection.endLine} (${active.selection.charCount} chars)`
        : 'none',
    ],
    [
      'Visible Range',
      active?.visibleExcerpt
        ? `L${active.visibleExcerpt.startLine}-${active.visibleExcerpt.endLine}`
        : 'n/a',
    ],
    [
      'Visible Editors',
      visibleEditors.length ? visibleEditors.map(editor => basename(editor.path)).join(', ') : 'none',
    ],
    ['Workspace', workspace?.cwd || 'unknown'],
    ['Folders', String(workspace?.folders?.length || 0)],
    ['Root Items', workspace?.topLevelEntries?.length ? workspace.topLevelEntries.slice(0, 8).join(', ') : 'n/a'],
  ];

  elements.context.innerHTML = rows
    .map(
      ([label, value]) => `
        <div class="fact-row">
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value)}</dd>
        </div>
      `,
    )
    .join('');
}

function renderFacts(state) {
  const facts = [
    ['Workspace', state.cwd || 'unknown'],
    ['Session ID', shortSessionId(state.sessionId)],
    ['Model', state.runtime?.model || state.selectedModel || 'pending'],
    ['Version', state.runtime?.claudeCodeVersion || 'pending'],
    ['Permission', state.runtime?.permissionMode || 'default'],
    ['Tools', String(state.runtime?.tools?.length || 0)],
    ['MCP', String(state.runtime?.mcpServers?.length || 0)],
    ['Turns', String(state.lastResult?.numTurns || 0)],
    ['Last Cost', formatUsd(state.lastResult?.totalCostUsd)],
  ];

  elements.facts.innerHTML = facts
    .map(
      ([label, value]) => `
        <div class="fact-row">
          <dt>${escapeHtml(label)}</dt>
          <dd>${escapeHtml(value)}</dd>
        </div>
      `,
    )
    .join('');
}

function renderActivity(state) {
  if (!state.activity || state.activity.length === 0) {
    elements.activity.innerHTML = '<div class="log-line muted">No events yet.</div>';
    return;
  }

  elements.activity.innerHTML = state.activity
    .map(
      entry => `
        <div class="log-line log-line--${escapeHtml(entry.level)}">
          <span class="log-time">${escapeHtml(formatTimestamp(entry.timestamp))}</span>
          <span class="log-text">${escapeHtml(entry.text)}</span>
        </div>
      `,
    )
    .join('');
}

function applyDetailsVisibility() {
  const openPanel = uiState.openPanel;
  const panels = {
    context: elements.contextPanel,
    facts: elements.factsPanel,
    activity: elements.activityPanel,
  };
  const titles = {
    context: 'IDE Context',
    facts: 'System State',
    activity: 'Operation Log',
  };

  const hasOpenPanel = Boolean(openPanel && panels[openPanel]);
  elements.detailsDrawer.classList.toggle('hidden', !hasOpenPanel);

  Object.entries(panels).forEach(([name, panel]) => {
    panel.classList.toggle('hidden', name !== openPanel);
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

function renderHistory(state) {
  const entries = Array.isArray(state.sessionHistory) ? state.sessionHistory : [];
  const preview = state.historyPreview;

  elements.historyDrawer.classList.toggle('hidden', !uiState.historyOpen);
  elements.historyButton.setAttribute('aria-pressed', uiState.historyOpen ? 'true' : 'false');

  if (!uiState.historyOpen) {
    return;
  }

  if (entries.length === 0) {
    elements.historyList.innerHTML = '<div class="history-empty">No archived sessions yet.</div>';
  } else {
    elements.historyList.innerHTML = entries
      .map(
        entry => `
          <button class="history-item${preview?.id === entry.id ? ' history-item--active' : ''}" data-history-id="${escapeHtml(entry.id)}" type="button">
            <strong>${escapeHtml(entry.title)}</strong>
            <span>${escapeHtml(entry.preview || '')}</span>
            <small>${escapeHtml(formatDateTime(entry.updatedAt))}</small>
          </button>
        `,
      )
      .join('');
  }

  if (!preview) {
    elements.historyPreview.innerHTML =
      '<div class="history-empty">Select a previous session to preview it here.</div>';
    return;
  }

  elements.historyPreview.innerHTML = `
    <div class="history-preview-header">
      <strong>${escapeHtml(preview.title)}</strong>
      <span>${escapeHtml([preview.model, preview.cwd].filter(Boolean).join(' • '))}</span>
    </div>
    <div class="history-preview-body">
      ${preview.messages
        .map(
          message => `
            <article class="message message--${escapeHtml(message.role)} message--tone-${escapeHtml(message.tone || message.role)} message--history">
              <div class="message-meta">
                <span>${escapeHtml(message.role === 'user' ? 'You' : 'MAGI')}</span>
                <span>${escapeHtml(formatTimestamp(message.timestamp))}</span>
              </div>
              <div class="message-body">${escapeHtml(message.text).replace(/\n/g, '<br>')}</div>
            </article>
          `,
        )
        .join('')}
    </div>
  `;
}

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
}

function syncComposerState(state) {
  const blocked = Boolean(state.pendingPermission) || Boolean(state.busy);
  if (elements.newSessionButton) {
    elements.newSessionButton.disabled = state.backendStatus === 'starting';
  }
  if (elements.planModeToggleButton) {
    elements.planModeToggleButton.disabled = blocked || state.backendStatus === 'starting';
  }
  if (elements.ideContextToggleButton) {
    elements.ideContextToggleButton.disabled = false;
  }
  if (elements.panelToggleButton) {
    elements.panelToggleButton.disabled = false;
  }
  if (elements.modelSelect) {
    elements.modelSelect.disabled =
      blocked || Boolean(state.pendingModelValue) || elements.modelSelect.options.length === 0;
  }
  if (elements.thinkingSelect) {
    elements.thinkingSelect.disabled = blocked || Boolean(state.pendingThinkingMode);
  }
  elements.promptInput.disabled = Boolean(state.pendingPermission);
  elements.promptInput.placeholder = state.pendingPermission
    ? 'Approve or deny the pending request before sending another prompt...'
    : state.busy
      ? 'MAGI is processing the current turn...'
      : 'Ask MAGI to inspect code, explain a file, or make a change...';
  updateComposerDraftState(state);
}

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
  renderHistory(state);
  renderWelcome(state);
  renderTranscript(state);
  applyDetailsVisibility();
  syncComposerState(state);
}

function sendPrompt() {
  const text = elements.promptInput.value.trim();
  if (!text) {
    return;
  }

  pendingPromptText = text;
  uiState.optimisticUserText = text;
  uiState.optimisticUserTimestamp = new Date().toISOString();
  if (currentState) {
    render(currentState);
  }
  vscode.postMessage({
    type: 'sendPrompt',
    text,
  });
}

bindEvent(elements.sendButton, 'click', sendPrompt);
bindEvent(elements.approveButton, 'click', () => {
  vscode.postMessage({ type: 'permissionDecision', allow: true });
});
bindEvent(elements.denyButton, 'click', () => {
  vscode.postMessage({ type: 'permissionDecision', allow: false });
});
bindEvent(elements.modelSelect, 'change', () => {
  vscode.postMessage({
    type: 'selectModel',
    value: elements.modelSelect.value,
  });
});
bindEvent(elements.thinkingSelect, 'change', () => {
  vscode.postMessage({
    type: 'selectThinkingMode',
    value: elements.thinkingSelect.value,
  });
});
bindEvent(elements.planModeToggleButton, 'click', () => {
  const enabled = elements.planModeToggleButton.getAttribute('aria-pressed') !== 'true';
  if (currentState) {
    currentState = {
      ...currentState,
      planModeEnabled: enabled,
    };
    render(currentState);
  }
  vscode.postMessage({
    type: 'togglePlanMode',
    enabled,
  });
});
bindEvent(elements.ideContextToggleButton, 'click', () => {
  const enabled = elements.ideContextToggleButton.getAttribute('aria-pressed') !== 'true';
  if (currentState) {
    currentState = {
      ...currentState,
      ideContextEnabled: enabled,
    };
    render(currentState);
  }
  vscode.postMessage({
    type: 'toggleIdeContext',
    enabled,
  });
});
bindEvent(elements.openSettingsButton, 'click', () => {
  vscode.postMessage({ type: 'openModelSettings' });
});
bindEvent(elements.newSessionButton, 'click', () => {
  uiState.historyOpen = false;
  elements.historyDrawer.classList.add('hidden');
  elements.historyButton.setAttribute('aria-pressed', 'false');
  vscode.postMessage({ type: 'newSession' });
});
bindEvent(elements.historyButton, 'click', () => {
  uiState.openPanel = null;
  applyDetailsVisibility();
  uiState.historyOpen = !uiState.historyOpen;
  if (!uiState.historyOpen) {
    vscode.postMessage({ type: 'clearHistoryPreview' });
  }
  elements.historyDrawer.classList.toggle('hidden', !uiState.historyOpen);
  elements.historyButton.setAttribute('aria-pressed', uiState.historyOpen ? 'true' : 'false');
});
bindEvent(elements.closeHistoryButton, 'click', () => {
  uiState.historyOpen = false;
  elements.historyDrawer.classList.add('hidden');
  elements.historyButton.setAttribute('aria-pressed', 'false');
  vscode.postMessage({ type: 'clearHistoryPreview' });
});
bindEvent(elements.closeDetailsButton, 'click', () => {
  uiState.openPanel = null;
  applyDetailsVisibility();
});

bindEvent(elements.panelToggleButton, 'click', () => {
  uiState.historyOpen = false;
  elements.historyDrawer.classList.add('hidden');
  elements.historyButton.setAttribute('aria-pressed', 'false');
  vscode.postMessage({ type: 'clearHistoryPreview' });
  uiState.openPanel = uiState.openPanel ? null : uiState.lastPanel || 'context';
  applyDetailsVisibility();
});

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
  });
});

bindEvent(elements.historyList, 'click', event => {
  const button = event.target.closest('[data-history-id]');
  if (!button) {
    return;
  }
  vscode.postMessage({
    type: 'openHistoryEntry',
    id: button.getAttribute('data-history-id'),
  });
});

bindEvent(elements.promptInput, 'keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !isPromptComposing && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    if (canSubmitPrompt()) {
      sendPrompt();
    }
  }
});

bindEvent(elements.promptInput, 'compositionstart', () => {
  isPromptComposing = true;
});

bindEvent(elements.promptInput, 'compositionend', () => {
  isPromptComposing = false;
  autoSizePromptInput();
  updateComposerDraftState();
});

bindEvent(elements.promptInput, 'input', () => {
  autoSizePromptInput();
  updateComposerDraftState();
});

window.addEventListener('message', event => {
  const message = event.data;
  if (!message) {
    return;
  }

  if (message.type === 'state') {
    render(message.state);
    return;
  }

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
    if (currentState) {
      render(currentState);
    } else {
      updateComposerDraftState();
    }
    return;
  }

  if (message.type === 'focusInput') {
    elements.promptInput.focus();
    vscode.postMessage({ type: 'focusInputAck' });
  }
});

autoSizePromptInput();
updateComposerDraftState();
vscode.postMessage({ type: 'ready' });
