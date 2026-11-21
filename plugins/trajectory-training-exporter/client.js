window.__ModuleLoader__.load({
  id: '@local/trajectory-training-exporter',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const NS = 'trajectory-training-exporter';
    const SESSIONS_ROUTE = 'api/trajectory-training.sessions';
    const EXPORT_ROUTE = 'api/trajectory-training.export';

    const zh = {
      'view.tab': '导出训练数据',
      'header.button': '导出训练数据',
      'header.tooltip': '将已保存轨迹导出为可训练 Agent 数据格式 (JSONL)',
      'menu.exportTraining': '导出为可训练 Agent 数据…',
      'modal.title': '导出可训练 Agent 轨迹数据',
      'modal.subtitle': '将已保存的会话轨迹转换为可用于 SFT 微调、强化学习 (RL/GRPO) 或过程奖励建模的标准数据集格式。',
      'modal.close': '关闭',
      'scope.label': '轨迹范围',
      'scope.current': '当前会话轨迹',
      'scope.selected': '选择已保存轨迹 (批量)',
      'scope.all': '全部已保存轨迹',
      'sessions.SelectAll': '全选',
      'sessions.SelectNone': '清空',
      'sessions.refresh': '刷新列表',
      'sessions.loading': '正在读取已保存轨迹…',
      'sessions.empty': '暂无已保存的会话轨迹',
      'format.label': '训练数据格式',
      'format.openai_chat.title': 'OpenAI Chat / Tool-Use SFT (.jsonl)',
      'format.openai_chat.desc': '标准 messages + tools + reasoning_content 结构，兼容 TRL、verl、Axolotl、Slime、vLLM。',
      'format.sharegpt.title': 'ShareGPT / LLaMA-Factory (.jsonl)',
      'format.sharegpt.desc': '包含 conversations (human / function_call / observation / gpt)、system 与 tools，兼容 LLaMA-Factory。',
      'format.agent_steps.title': 'Step-wise Agent RL / PRM (.jsonl)',
      'format.agent_steps.desc': '按单步决策展开 (prompt_messages, action, observations, usage, reward, done)，适用于 GRPO / RL 与过程监督。',
      'format.raw_trajectory.title': '完整结构化轨迹 (.jsonl)',
      'format.raw_trajectory.desc': '保留完整 Turn / Step 层级、推理链、工具调用与 Token 统计信息。',
      'options.label': '导出与清洗选项',
      'options.includeReasoning': '保留思考链 (Reasoning / <think>)',
      'options.includeTools': '包含工具定义 Schema (tools)',
      'options.includeSystem': '包含系统提示词 (System / Developer)',
      'options.includeSubagents': '包含子 Agent (Subagent) 派生轨迹',
      'options.splitByTurn': '按单轮对话 (Turn) 切分为独立训练样本',
      'options.excludeErrors': '过滤包含报错或中断的轮次',
      'reasoningFormat.label': '思考链格式',
      'reasoningFormat.field': 'reasoning_content 独立字段 (DeepSeek / OpenAI 标准)',
      'reasoningFormat.think_tags': '<think>...</think> 内嵌标签 (ShareGPT / SFT 通用)',
      'reasoningFormat.both': '同时保留独立字段与 <think> 标签',
      'sourceMode.label': '事件源',
      'sourceMode.full_log': '完整历史日志 (含压缩前全部步骤)',
      'sourceMode.surface': '当前上下文表面 (仅保留压缩后可见上下文)',
      'outputPath.label': '保存到工作区文件路径 (可选)',
      'outputPath.placeholder': '例如: datasets/agent-train.jsonl (留空自动命名)',
      'stats.sessions': '导出会话数',
      'stats.samples': '训练样本数 (Lines)',
      'stats.turns': '对话轮次 (Turns)',
      'stats.steps': '决策步数 (Steps)',
      'stats.toolCalls': '工具调用数',
      'stats.size': '数据大小',
      'preview.label': 'JSONL 样本预览',
      'preview.loading': '正在生成训练样本预览…',
      'preview.empty': '所选轨迹中没有可导出的有效对话轮次。',
      'action.download': '下载 .jsonl 文件',
      'action.saveWorkspace': '保存到工作区',
      'action.copy': '复制 JSONL',
      'action.copied': '已复制到剪贴板',
      'status.saved': '已成功保存至工作区：{path} ({count} 条样本)',
      'status.downloaded': '已开始浏览器下载：{filename} ({count} 条样本)',
      'status.error': '导出失败：{error}',
    };

    const en = {
      'view.tab': 'Training export',
      'header.button': 'Export training data',
      'header.tooltip': 'Export saved trajectories into trainable agent dataset formats (JSONL)',
      'menu.exportTraining': 'Export as trainable agent data…',
      'modal.title': 'Export trainable agent trajectories',
      'modal.subtitle': 'Convert saved session trajectories into standardized datasets for SFT fine-tuning, RL/GRPO, or process reward modeling.',
      'modal.close': 'Close',
      'scope.label': 'Trajectory scope',
      'scope.current': 'Current session',
      'scope.selected': 'Select saved trajectories (batch)',
      'scope.all': 'All saved trajectories',
      'sessions.SelectAll': 'Select all',
      'sessions.SelectNone': 'Clear',
      'sessions.refresh': 'Refresh',
      'sessions.loading': 'Loading saved trajectories…',
      'sessions.empty': 'No saved trajectories found',
      'format.label': 'Training dataset format',
      'format.openai_chat.title': 'OpenAI Chat / Tool-Use SFT (.jsonl)',
      'format.openai_chat.desc': 'Standard messages + tools + reasoning_content format for TRL, verl, Axolotl, Slime, and vLLM.',
      'format.sharegpt.title': 'ShareGPT / LLaMA-Factory (.jsonl)',
      'format.sharegpt.desc': 'Multi-turn conversations (human / function_call / observation / gpt) with system and tools for LLaMA-Factory.',
      'format.agent_steps.title': 'Step-wise Agent RL / PRM (.jsonl)',
      'format.agent_steps.desc': 'Unrolled per-step decision samples (prompt_messages, action, observations, usage, reward, done) for GRPO / RL.',
      'format.raw_trajectory.title': 'Structured trajectory (.jsonl)',
      'format.raw_trajectory.desc': 'Complete turn/step hierarchy, reasoning traces, tool calls, and token usage statistics.',
      'options.label': 'Export & filtering options',
      'options.includeReasoning': 'Include reasoning traces (reasoning_content / <think>)',
      'options.includeTools': 'Include tool schemas (tools)',
      'options.includeSystem': 'Include system & developer prompts',
      'options.includeSubagents': 'Include descendant subagent trajectories',
      'options.splitByTurn': 'Split into one training sample per turn',
      'options.excludeErrors': 'Skip turns with errors or aborts',
      'reasoningFormat.label': 'Reasoning format',
      'reasoningFormat.field': 'reasoning_content field (DeepSeek / OpenAI standard)',
      'reasoningFormat.think_tags': '<think>...</think> inline tags',
      'reasoningFormat.both': 'Both reasoning_content field and <think> tags',
      'sourceMode.label': 'Event source',
      'sourceMode.full_log': 'Full committed log (all steps before compaction)',
      'sourceMode.surface': 'Active surface (post-compaction context only)',
      'outputPath.label': 'Workspace output file path (optional)',
      'outputPath.placeholder': 'e.g. datasets/agent-train.jsonl (blank for auto filename)',
      'stats.sessions': 'Sessions',
      'stats.samples': 'Samples (Lines)',
      'stats.turns': 'Turns',
      'stats.steps': 'Agent steps',
      'stats.toolCalls': 'Tool calls',
      'stats.size': 'Dataset size',
      'preview.label': 'JSONL sample preview',
      'preview.loading': 'Generating training dataset preview…',
      'preview.empty': 'No exportable turns found in the selected trajectory.',
      'action.download': 'Download .jsonl',
      'action.saveWorkspace': 'Save to workspace',
      'action.copy': 'Copy JSONL',
      'action.copied': 'Copied to clipboard',
      'status.saved': 'Saved to workspace: {path} ({count} samples)',
      'status.downloaded': 'Browser download started: {filename} ({count} samples)',
      'status.error': 'Export failed: {error}',
    };

    const CSS_TEXT = `
      .tte-header-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 28px;
        padding: 0 10px;
        border-radius: 6px;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary);
        font-size: 12px;
        font-weight: 500;
        line-height: 1;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
        transition: background 0.15s ease, border-color 0.15s ease;
      }
      .tte-header-btn:hover {
        background: var(--dsw-alias-bg-layer-2);
        border-color: var(--dsw-alias-border-l2);
      }
      .tte-menu-item {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 6px 10px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--dsw-alias-label-primary);
        font-size: 13px;
        text-align: left;
        cursor: pointer;
      }
      .tte-menu-item:hover {
        background: var(--dsw-alias-bg-layer-2);
      }
      .tte-view-root {
        display: flex;
        flex-direction: column;
        width: 100%;
        min-height: 100%;
        box-sizing: border-box;
        padding: 20px 28px 140px;
        background: var(--dsw-alias-bg-base);
        color: var(--dsw-alias-label-primary);
      }
      .tte-view-container {
        width: 100%;
        max-width: 880px;
        margin: 0 auto;
        border-radius: 12px;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-base);
        overflow: hidden;
      }
      .tte-backdrop {
        position: fixed;
        inset: 0;
        z-index: 9999;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        background: rgba(0, 0, 0, 0.48);
        backdrop-filter: blur(2px);
      }
      .tte-modal {
        display: flex;
        flex-direction: column;
        width: 100%;
        max-width: 860px;
        max-height: 88vh;
        border-radius: 12px;
        border: 1px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-base);
        color: var(--dsw-alias-label-primary);
        box-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
        overflow: hidden;
      }
      .tte-modal-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        padding: 16px 20px;
        border-bottom: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-1);
      }
      .tte-modal-title {
        margin: 0;
        font-size: 16px;
        font-weight: 600;
        color: var(--dsw-alias-label-primary);
      }
      .tte-modal-subtitle {
        margin: 4px 0 0;
        font-size: 12px;
        color: var(--dsw-alias-label-secondary);
      }
      .tte-close-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: 6px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--dsw-alias-label-secondary);
        cursor: pointer;
      }
      .tte-close-btn:hover {
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary);
      }
      .tte-modal-body {
        display: flex;
        flex-direction: column;
        gap: 16px;
        padding: 16px 20px;
        overflow-y: auto;
      }
      .tte-section-label {
        font-size: 12px;
        font-weight: 600;
        color: var(--dsw-alias-label-secondary);
        margin-bottom: 8px;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .tte-scope-tabs {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .tte-scope-tab {
        padding: 6px 12px;
        border-radius: 6px;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary);
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
      }
      .tte-scope-tab[data-active="true"] {
        border-color: var(--dsw-alias-brand-primary);
        color: var(--dsw-alias-brand-primary);
        background: var(--dsw-alias-bg-layer-2);
      }
      .tte-session-list {
        max-height: 160px;
        overflow-y: auto;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 8px;
        background: var(--dsw-alias-bg-layer-1);
        padding: 6px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .tte-session-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 6px 8px;
        border-radius: 6px;
        font-size: 12px;
        cursor: pointer;
      }
      .tte-session-item:hover {
        background: var(--dsw-alias-bg-layer-2);
      }
      .tte-format-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      .tte-format-card {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-1);
        text-align: left;
        cursor: pointer;
      }
      .tte-format-card:hover {
        background: var(--dsw-alias-bg-layer-2);
      }
      .tte-format-card[data-active="true"] {
        border-color: var(--dsw-alias-brand-primary);
        background: var(--dsw-alias-bg-layer-2);
      }
      .tte-format-card-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--dsw-alias-label-primary);
      }
      .tte-format-card[data-active="true"] .tte-format-card-title {
        color: var(--dsw-alias-brand-primary);
      }
      .tte-format-card-desc {
        font-size: 11px;
        line-height: 1.4;
        color: var(--dsw-alias-label-secondary);
      }
      .tte-options-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px 16px;
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-1);
      }
      .tte-checkbox-row {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        color: var(--dsw-alias-label-primary);
        cursor: pointer;
        user-select: none;
      }
      .tte-select-row {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }
      .tte-input, .tte-select {
        width: 100%;
        height: 32px;
        padding: 0 10px;
        border-radius: 6px;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary);
        font-size: 12px;
        box-sizing: border-box;
      }
      .tte-stats-bar {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: 8px;
      }
      .tte-stat-card {
        padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-1);
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .tte-stat-value {
        font-size: 15px;
        font-weight: 600;
        color: var(--dsw-alias-brand-primary);
      }
      .tte-stat-label {
        font-size: 11px;
        color: var(--dsw-alias-label-secondary);
      }
      .tte-preview-box {
        margin: 0;
        padding: 10px 12px;
        max-height: 220px;
        overflow: auto;
        border-radius: 8px;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 11px;
        line-height: 1.45;
        white-space: pre-wrap;
        word-break: break-all;
      }
      .tte-status-banner {
        padding: 8px 12px;
        border-radius: 6px;
        font-size: 12px;
        border: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-1);
      }
      .tte-status-banner[data-tone="success"] {
        border-color: var(--dsw-alias-state-success-primary);
        color: var(--dsw-alias-state-success-primary);
      }
      .tte-status-banner[data-tone="error"] {
        border-color: var(--dsw-alias-state-error-primary);
        color: var(--dsw-alias-state-error-primary);
      }
      .tte-modal-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 20px;
        border-top: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-1);
      }
      .tte-btn-group {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-left: auto;
      }
      .tte-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 32px;
        padding: 0 14px;
        border-radius: 6px;
        border: 1px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-label-primary);
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
      }
      .tte-btn:hover:not(:disabled) {
        border-color: var(--dsw-alias-brand-primary);
      }
      .tte-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .tte-btn-primary {
        border-color: var(--dsw-alias-brand-primary);
        background: var(--dsw-alias-brand-primary);
        color: var(--dsw-alias-bg-base);
        font-weight: 600;
      }
    `;

    function DatasetIcon({ size = 14 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          style: { flexShrink: 0, display: 'block' },
        },
        h('path', {
          d: 'M3 2.5C3 1.94772 3.44772 1.5 4 1.5H9.29289C9.55811 1.5 9.81246 1.60536 10 1.79289L12.7071 4.5C12.8946 4.68754 13 4.94189 13 5.20711V13.5C13 14.0523 12.5523 14.5 12 14.5H4C3.44772 14.5 3 14.0523 3 13.5V2.5Z',
          stroke: 'currentColor',
          strokeWidth: '1.3',
        }),
        h('circle', { cx: '6', cy: '6.5', r: '1', fill: 'currentColor' }),
        h('circle', { cx: '6', cy: '10', r: '1', fill: 'currentColor' }),
        h('path', {
          d: 'M8 8.25H11M11 8.25L9.6 6.85M11 8.25L9.6 9.65',
          stroke: 'currentColor',
          strokeWidth: '1.3',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    function formatBytes(bytes) {
      const n = Number(bytes || 0);
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
      return `${(n / (1024 * 1024)).toFixed(2)} MB`;
    }

    class ExporterModalState {
      constructor() {
        this.state = {
          open: false,
          sessionId: null,
          scopeMode: 'current',
        };
        this.listeners = new Set();
      }
      getSnapshot() {
        return this.state;
      }
      subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
      }
      openForSession(sessionId, scopeMode = 'current') {
        this.state = {
          open: true,
          sessionId: sessionId ? String(sessionId) : null,
          scopeMode: sessionId ? scopeMode : 'all',
        };
        for (const fn of this.listeners) fn();
      }
      close() {
        if (!this.state.open) return;
        this.state = { ...this.state, open: false };
        for (const fn of this.listeners) fn();
      }
    }

    function useStoreSnapshot(store) {
      const [snap, setSnap] = useState(() => store.getSnapshot());
      useEffect(() => {
        setSnap(store.getSnapshot());
        return store.subscribe(() => setSnap(store.getSnapshot()));
      }, [store]);
      return snap;
    }

    function resolveTranslatedText(localeService, key, vars) {
      const active = localeService?.getSnapshot()?.active || 'zh';
      const dict = String(active).startsWith('zh') ? zh : en;
      let text = (localeService ? localeService.bind(NS)(key) : '') || dict[key] || en[key] || key;
      if (text === key) {
        text = dict[key] || en[key] || key;
      }
      if (vars && typeof vars === 'object') {
        for (const [k, v] of Object.entries(vars)) {
          text = text.replace(`{${k}}`, String(v));
        }
      }
      return text;
    }

    function useTranslator(localeService) {
      const [, setRev] = useState(() => (localeService ? localeService.getSnapshot().revision : 0));
      useEffect(() => {
        if (!localeService) return undefined;
        return localeService.subscribe(() => {
          setRev(localeService.getSnapshot().revision);
        });
      }, [localeService]);
      return useCallback(
        (key, vars) => resolveTranslatedText(localeService, key, vars),
        [localeService],
      );
    }

    /**
     * Shared interactive Training Dataset Exporter Workbench used both in:
     * 1. The inline `conversation.view` tab right next to the "轨迹" (Trajectory) tab button
     * 2. The floating modal opened from the header button or context menu
     */
    function ExporterWorkbench({ sessionId, initialScopeMode = 'current', onClose, localeService }) {
      const t = useTranslator(localeService);

      const [scopeMode, setScopeMode] = useState(sessionId ? initialScopeMode : 'all');
      const [format, setFormat] = useState('openai_chat');
      const [sourceMode, setSourceMode] = useState('full_log');
      const [reasoningFormat, setReasoningFormat] = useState('field');
      const [includeReasoning, setIncludeReasoning] = useState(true);
      const [includeTools, setIncludeTools] = useState(true);
      const [includeSystem, setIncludeSystem] = useState(true);
      const [includeSubagents, setIncludeSubagents] = useState(true);
      const [splitByTurn, setSplitByTurn] = useState(false);
      const [excludeErrors, setExcludeErrors] = useState(false);
      const [outputPath, setOutputPath] = useState('');

      const [savedSessions, setSavedSessions] = useState([]);
      const [selectedIds, setSelectedIds] = useState(() => (sessionId ? [String(sessionId)] : []));
      const [loadingSessions, setLoadingSessions] = useState(false);

      const [previewState, setPreviewState] = useState({
        loading: false,
        stats: null,
        previewText: '',
        filename: 'trajectories.jsonl',
        error: null,
      });
      const [actionNotice, setActionNotice] = useState(null);
      const [copied, setCopied] = useState(false);
      const [busyAction, setBusyAction] = useState(false);

      useEffect(() => {
        if (sessionId) {
          setSelectedIds((prev) => (prev.length > 0 ? prev : [String(sessionId)]));
        }
      }, [sessionId]);

      const fetchSessions = useCallback(async () => {
        setLoadingSessions(true);
        try {
          const res = await fetch(`${SESSIONS_ROUTE}?includeSubagents=${includeSubagents ? 'true' : 'false'}`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          const list = Array.isArray(data.sessions) ? data.sessions : [];
          setSavedSessions(list);
          setSelectedIds((prev) => {
            if (prev.length > 0) return prev;
            if (sessionId) return [String(sessionId)];
            return list.slice(0, 5).map((s) => s.sessionId);
          });
        } catch {
          // Keep current list on transient error
        } finally {
          setLoadingSessions(false);
        }
      }, [includeSubagents, sessionId]);

      useEffect(() => {
        fetchSessions();
      }, [fetchSessions]);

      const resolvedTargetSessionIds = useCallback(() => {
        if (scopeMode === 'current' && sessionId) {
          return [String(sessionId)];
        }
        if (scopeMode === 'all') {
          return 'all';
        }
        return selectedIds.length > 0 ? selectedIds : (sessionId ? [String(sessionId)] : 'all');
      }, [scopeMode, sessionId, selectedIds]);

      useEffect(() => {
        const abort = new AbortController();
        setPreviewState((prev) => ({ ...prev, loading: true, error: null }));

        const timer = setTimeout(async () => {
          try {
            const res = await fetch(EXPORT_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                action: 'preview',
                maxPreviewSamples: 5,
                sessionIds: resolvedTargetSessionIds(),
                format,
                sourceMode,
                includeSubagents,
                includeReasoning,
                reasoningFormat,
                includeSystem,
                includeTools,
                splitByTurn,
                excludeErrors,
              }),
              signal: abort.signal,
            });
            if (!res.ok) {
              const txt = await res.text().catch(() => '');
              throw new Error(txt || `HTTP ${res.status}`);
            }
            const data = await res.json();
            if (abort.signal.aborted) return;
            setPreviewState({
              loading: false,
              stats: data.stats || null,
              previewText: data.previewText || '',
              filename: data.filename || 'trajectories.jsonl',
              error: null,
            });
          } catch (err) {
            if (abort.signal.aborted) return;
            setPreviewState((prev) => ({
              ...prev,
              loading: false,
              error: err instanceof Error ? err.message : String(err),
            }));
          }
        }, 120);

        return () => {
          clearTimeout(timer);
          abort.abort();
        };
      }, [
        scopeMode,
        selectedIds,
        format,
        sourceMode,
        includeSubagents,
        includeReasoning,
        reasoningFormat,
        includeSystem,
        includeTools,
        splitByTurn,
        excludeErrors,
        resolvedTargetSessionIds,
      ]);

      const handleDownload = () => {
        setActionNotice(null);
        const target = resolvedTargetSessionIds();
        const sessionIdsParam = Array.isArray(target) ? target.join(',') : 'all';
        const params = new URLSearchParams({
          sessionIds: sessionIdsParam,
          format,
          sourceMode,
          includeSubagents: String(includeSubagents),
          includeReasoning: String(includeReasoning),
          reasoningFormat,
          includeSystem: String(includeSystem),
          includeTools: String(includeTools),
          splitByTurn: String(splitByTurn),
          excludeErrors: String(excludeErrors),
        });
        const url = `${EXPORT_ROUTE}?${params.toString()}`;
        const a = document.createElement('a');
        a.href = url;
        a.download = previewState.filename || `trajectories-${format}.jsonl`;
        a.click();
        setActionNotice({
          tone: 'success',
          text: t('status.downloaded', {
            filename: a.download,
            count: previewState.stats?.sampleCount ?? 0,
          }),
        });
      };

      const handleSaveToWorkspace = async () => {
        setBusyAction(true);
        setActionNotice(null);
        try {
          const res = await fetch(EXPORT_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              action: 'save',
              sessionIds: resolvedTargetSessionIds(),
              format,
              sourceMode,
              includeSubagents,
              includeReasoning,
              reasoningFormat,
              includeSystem,
              includeTools,
              splitByTurn,
              excludeErrors,
              outputPath: outputPath.trim() || undefined,
            }),
          });
          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(errText || `HTTP ${res.status}`);
          }
          const data = await res.json();
          setActionNotice({
            tone: 'success',
            text: t('status.saved', {
              path: data.savedPath || data.filename,
              count: data.stats?.sampleCount ?? 0,
            }),
          });
        } catch (err) {
          setActionNotice({
            tone: 'error',
            text: t('status.error', {
              error: err instanceof Error ? err.message : String(err),
            }),
          });
        } finally {
          setBusyAction(false);
        }
      };

      const handleCopyJsonl = async () => {
        setBusyAction(true);
        try {
          const res = await fetch(EXPORT_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              action: 'preview',
              includeFullContent: true,
              sessionIds: resolvedTargetSessionIds(),
              format,
              sourceMode,
              includeSubagents,
              includeReasoning,
              reasoningFormat,
              includeSystem,
              includeTools,
              splitByTurn,
              excludeErrors,
            }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          await navigator.clipboard.writeText(data.jsonlContent || '');
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch (err) {
          setActionNotice({
            tone: 'error',
            text: t('status.error', {
              error: err instanceof Error ? err.message : String(err),
            }),
          });
        } finally {
          setBusyAction(false);
        }
      };

      const toggleSessionSelection = (id) => {
        setSelectedIds((prev) =>
          prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
        );
      };

      const stats = previewState.stats;

      return h(
        React.Fragment,
        null,
        // Header
        h(
          'div',
          { className: 'tte-modal-header' },
          h(
            'div',
            null,
            h('h2', { className: 'tte-modal-title' }, t('modal.title')),
            h('p', { className: 'tte-modal-subtitle' }, t('modal.subtitle')),
          ),
          onClose
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'tte-close-btn',
                  title: t('modal.close'),
                  'aria-label': t('modal.close'),
                  onClick: onClose,
                },
                '✕',
              )
            : null,
        ),
        // Body
        h(
          'div',
          { className: 'tte-modal-body' },
          // 1. Scope selector
          h(
            'div',
            null,
            h('div', { className: 'tte-section-label' }, h('span', null, t('scope.label'))),
            h(
              'div',
              { className: 'tte-scope-tabs' },
              sessionId
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'tte-scope-tab',
                      'data-active': String(scopeMode === 'current'),
                      onClick: () => setScopeMode('current'),
                    },
                    `${t('scope.current')} (${String(sessionId).slice(0, 8)})`,
                  )
                : null,
              h(
                'button',
                {
                  type: 'button',
                  className: 'tte-scope-tab',
                  'data-active': String(scopeMode === 'selected'),
                  onClick: () => setScopeMode('selected'),
                },
                `${t('scope.selected')} (${selectedIds.length})`,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'tte-scope-tab',
                  'data-active': String(scopeMode === 'all'),
                  onClick: () => setScopeMode('all'),
                },
                `${t('scope.all')} (${savedSessions.length})`,
              ),
            ),
            scopeMode === 'selected'
              ? h(
                  'div',
                  { style: { marginTop: '8px' } },
                  h(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        gap: '8px',
                        marginBottom: '6px',
                        fontSize: '11px',
                      },
                    },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'tte-scope-tab',
                        onClick: () => setSelectedIds(savedSessions.map((s) => s.sessionId)),
                      },
                      t('sessions.SelectAll'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'tte-scope-tab',
                        onClick: () => setSelectedIds([]),
                      },
                      t('sessions.SelectNone'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'tte-scope-tab',
                        onClick: fetchSessions,
                      },
                      t('sessions.refresh'),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'tte-session-list' },
                    loadingSessions
                      ? h('div', { style: { padding: '8px', fontSize: '12px' } }, t('sessions.loading'))
                      : savedSessions.length === 0
                        ? h('div', { style: { padding: '8px', fontSize: '12px' } }, t('sessions.empty'))
                        : savedSessions.map((sess) =>
                            h(
                              'label',
                              {
                                key: sess.sessionId,
                                className: 'tte-session-item',
                              },
                              h(
                                'span',
                                { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
                                h('input', {
                                  type: 'checkbox',
                                  checked: selectedIds.includes(sess.sessionId),
                                  onChange: () => toggleSessionSelection(sess.sessionId),
                                }),
                                h(
                                  'span',
                                  {
                                    style: {
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      whiteSpace: 'nowrap',
                                      fontWeight: 500,
                                    },
                                  },
                                  sess.title,
                                ),
                              ),
                              h(
                                'span',
                                {
                                  style: {
                                    color: 'var(--dsw-alias-label-secondary)',
                                    fontSize: '11px',
                                    flexShrink: 0,
                                  },
                                },
                                `${sess.sessionId.slice(0, 8)} · ${new Date(sess.createdAt).toLocaleString()}`,
                              ),
                            ),
                          ),
                  ),
                )
              : null,
          ),

          // 2. Format cards
          h(
            'div',
            null,
            h('div', { className: 'tte-section-label' }, h('span', null, t('format.label'))),
            h(
              'div',
              { className: 'tte-format-grid' },
              ['openai_chat', 'sharegpt', 'agent_steps', 'raw_trajectory'].map((fmt) =>
                h(
                  'button',
                  {
                    key: fmt,
                    type: 'button',
                    className: 'tte-format-card',
                    'data-active': String(format === fmt),
                    onClick: () => setFormat(fmt),
                  },
                  h('div', { className: 'tte-format-card-title' }, t(`format.${fmt}.title`)),
                  h('div', { className: 'tte-format-card-desc' }, t(`format.${fmt}.desc`)),
                ),
              ),
            ),
          ),

          // 3. Options
          h(
            'div',
            null,
            h('div', { className: 'tte-section-label' }, h('span', null, t('options.label'))),
            h(
              'div',
              { className: 'tte-options-grid' },
              h(
                'label',
                { className: 'tte-checkbox-row' },
                h('input', {
                  type: 'checkbox',
                  checked: includeReasoning,
                  onChange: (e) => setIncludeReasoning(e.target.checked),
                }),
                h('span', null, t('options.includeReasoning')),
              ),
              h(
                'label',
                { className: 'tte-checkbox-row' },
                h('input', {
                  type: 'checkbox',
                  checked: includeTools,
                  onChange: (e) => setIncludeTools(e.target.checked),
                }),
                h('span', null, t('options.includeTools')),
              ),
              h(
                'label',
                { className: 'tte-checkbox-row' },
                h('input', {
                  type: 'checkbox',
                  checked: includeSystem,
                  onChange: (e) => setIncludeSystem(e.target.checked),
                }),
                h('span', null, t('options.includeSystem')),
              ),
              h(
                'label',
                { className: 'tte-checkbox-row' },
                h('input', {
                  type: 'checkbox',
                  checked: includeSubagents,
                  onChange: (e) => setIncludeSubagents(e.target.checked),
                }),
                h('span', null, t('options.includeSubagents')),
              ),
              h(
                'label',
                { className: 'tte-checkbox-row' },
                h('input', {
                  type: 'checkbox',
                  checked: splitByTurn,
                  onChange: (e) => setSplitByTurn(e.target.checked),
                }),
                h('span', null, t('options.splitByTurn')),
              ),
              h(
                'label',
                { className: 'tte-checkbox-row' },
                h('input', {
                  type: 'checkbox',
                  checked: excludeErrors,
                  onChange: (e) => setExcludeErrors(e.target.checked),
                }),
                h('span', null, t('options.excludeErrors')),
              ),
            ),
          ),

          // 4. Selectors & Workspace Path
          h(
            'div',
            { className: 'tte-select-row' },
            h(
              'div',
              null,
              h('div', { className: 'tte-section-label' }, h('span', null, t('reasoningFormat.label'))),
              h(
                'select',
                {
                  className: 'tte-select',
                  value: reasoningFormat,
                  disabled: !includeReasoning,
                  onChange: (e) => setReasoningFormat(e.target.value),
                },
                h('option', { value: 'field' }, t('reasoningFormat.field')),
                h('option', { value: 'think_tags' }, t('reasoningFormat.think_tags')),
                h('option', { value: 'both' }, t('reasoningFormat.both')),
              ),
            ),
            h(
              'div',
              null,
              h('div', { className: 'tte-section-label' }, h('span', null, t('sourceMode.label'))),
              h(
                'select',
                {
                  className: 'tte-select',
                  value: sourceMode,
                  onChange: (e) => setSourceMode(e.target.value),
                },
                h('option', { value: 'full_log' }, t('sourceMode.full_log')),
                h('option', { value: 'surface' }, t('sourceMode.surface')),
              ),
            ),
          ),

          h(
            'div',
            null,
            h('div', { className: 'tte-section-label' }, h('span', null, t('outputPath.label'))),
            h('input', {
              type: 'text',
              className: 'tte-input',
              placeholder: t('outputPath.placeholder'),
              value: outputPath,
              onChange: (e) => setOutputPath(e.target.value),
            }),
          ),

          // 5. Dataset statistics bar
          stats
            ? h(
                'div',
                { className: 'tte-stats-bar' },
                h(
                  'div',
                  { className: 'tte-stat-card' },
                  h('span', { className: 'tte-stat-value' }, String(stats.exportedSessionCount ?? 0)),
                  h('span', { className: 'tte-stat-label' }, t('stats.sessions')),
                ),
                h(
                  'div',
                  { className: 'tte-stat-card' },
                  h('span', { className: 'tte-stat-value' }, String(stats.sampleCount ?? 0)),
                  h('span', { className: 'tte-stat-label' }, t('stats.samples')),
                ),
                h(
                  'div',
                  { className: 'tte-stat-card' },
                  h('span', { className: 'tte-stat-value' }, String(stats.totalTurns ?? 0)),
                  h('span', { className: 'tte-stat-label' }, t('stats.turns')),
                ),
                h(
                  'div',
                  { className: 'tte-stat-card' },
                  h('span', { className: 'tte-stat-value' }, String(stats.totalSteps ?? 0)),
                  h('span', { className: 'tte-stat-label' }, t('stats.steps')),
                ),
                h(
                  'div',
                  { className: 'tte-stat-card' },
                  h('span', { className: 'tte-stat-value' }, String(stats.totalToolCalls ?? 0)),
                  h('span', { className: 'tte-stat-label' }, t('stats.toolCalls')),
                ),
                h(
                  'div',
                  { className: 'tte-stat-card' },
                  h('span', { className: 'tte-stat-value' }, formatBytes(stats.byteLength)),
                  h('span', { className: 'tte-stat-label' }, t('stats.size')),
                ),
              )
            : null,

          // 6. Live Sample Preview
          h(
            'div',
            null,
            h(
              'div',
              { className: 'tte-section-label' },
              h('span', null, t('preview.label')),
              h('span', { style: { fontWeight: 400 } }, previewState.filename),
            ),
            h(
              'pre',
              { className: 'tte-preview-box' },
              previewState.loading
                ? t('preview.loading')
                : previewState.error
                  ? previewState.error
                  : previewState.previewText || t('preview.empty'),
            ),
          ),

          actionNotice
            ? h(
                'div',
                {
                  className: 'tte-status-banner',
                  'data-tone': actionNotice.tone,
                },
                actionNotice.text,
              )
            : null,
        ),
        // Footer
        h(
          'div',
          { className: 'tte-modal-footer' },
          onClose
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'tte-btn',
                  onClick: onClose,
                },
                t('modal.close'),
              )
            : null,
          h(
            'div',
            { className: 'tte-btn-group' },
            h(
              'button',
              {
                type: 'button',
                className: 'tte-btn',
                disabled: busyAction || (stats && stats.sampleCount === 0),
                onClick: handleCopyJsonl,
              },
              copied ? t('action.copied') : t('action.copy'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'tte-btn',
                disabled: busyAction || (stats && stats.sampleCount === 0),
                onClick: handleSaveToWorkspace,
              },
              t('action.saveWorkspace'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'tte-btn tte-btn-primary',
                disabled: busyAction || (stats && stats.sampleCount === 0),
                onClick: handleDownload,
              },
              h(DatasetIcon, { size: 14 }),
              h('span', null, t('action.download')),
            ),
          ),
        ),
      );
    }

    /**
     * Inline Conversation View component rendered when the user clicks the
     * "导出训练数据" tab right next to the "轨迹" (Trajectory) tab!
     */
    function TrainingExporterConversationView(props) {
      const { sessionId, localeService } = props;
      return h(
        'div',
        {
          className: 'tte-view-root',
          'data-conversation-composer-overlay': '',
        },
        h(
          'div',
          { className: 'tte-view-container' },
          h(ExporterWorkbench, {
            sessionId,
            initialScopeMode: 'current',
            localeService,
          }),
        ),
      );
    }

    function HeaderExportButton(props) {
      const { sessionId, modalState, localeService } = props;
      const t = useTranslator(localeService);
      if (!sessionId) return null;
      return h(
        'button',
        {
          type: 'button',
          className: 'tte-header-btn',
          title: t('header.tooltip'),
          onClick: () => modalState.openForSession(sessionId, 'current'),
        },
        h(DatasetIcon, { size: 14 }),
        h('span', null, t('header.button')),
      );
    }

    function SidebarSessionMenuItem(props) {
      const { sessionId, useMenuOpenState, modalState, localeService } = props;
      const t = useTranslator(localeService);
      const setOpen = typeof useMenuOpenState === 'function'
        ? useMenuOpenState((s) => s.setOpen)
        : null;
      if (!sessionId) return null;
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          className: 'tte-menu-item',
          onClick: () => {
            if (typeof setOpen === 'function') setOpen(false);
            modalState.openForSession(sessionId, 'current');
          },
        },
        h(DatasetIcon, { size: 15 }),
        h('span', null, t('menu.exportTraining')),
      );
    }

    function ExporterModalOverlay({ modalState, localeService }) {
      const snap = useStoreSnapshot(modalState);
      const t = useTranslator(localeService);

      useEffect(() => {
        if (!snap.open) return undefined;
        const onKeyDown = (e) => {
          if (e.key === 'Escape') {
            modalState.close();
          }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [snap.open, modalState]);

      if (!snap.open) return null;

      return h(
        'div',
        {
          className: 'tte-backdrop',
          onMouseDown: (e) => {
            if (e.target === e.currentTarget) modalState.close();
          },
        },
        h(
          'div',
          {
            className: 'tte-modal',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('modal.title'),
          },
          h(ExporterWorkbench, {
            sessionId: snap.sessionId,
            initialScopeMode: snap.scopeMode || 'current',
            onClose: () => modalState.close(),
            localeService,
          }),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const modalState = new ExporterModalState();
        const localeService = ctx.get('locale');

        // 1. Inject stylesheet with automatic disposal
        ctx.effect(() => {
          const styleEl = document.createElement('style');
          styleEl.setAttribute('data-plugin', '@local/trajectory-training-exporter');
          styleEl.textContent = CSS_TEXT;
          document.head.appendChild(styleEl);
          return () => {
            styleEl.remove();
          };
        }, 'trajectory-training-exporter: styles');

        // 2. Register client locale dictionaries
        if (localeService) {
          ctx.effect(
            () => localeService.register(NS, 'zh', zh),
            'trajectory-training-exporter: zh dictionary',
          );
          ctx.effect(
            () => localeService.register(NS, 'en', en),
            'trajectory-training-exporter: en dictionary',
          );
        }

        // 3. Register in `conversation.view` right next to "对话" (order 0) and "轨迹" (order 10)!
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            {
              name: 'conversation.view',
              id: 'trajectory-training-exporter',
              order: 20,
              locale: NS,
              label: () => resolveTranslatedText(localeService, 'view.tab'),
              inject: () => ({ localeService }),
            },
            TrainingExporterConversationView,
          ),
        );

        // 4. Register Session Header Utility Button
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'trajectory-training-exporter',
              order: 15,
              inject: () => ({ modalState, localeService }),
            },
            HeaderExportButton,
          ),
        );

        // 5. Register Session Header Context Menu item & icon when contextMenus is available
        ctx.slots.inject('contextMenu.icon', () =>
          ctx.slots.register(
            {
              name: 'contextMenu.icon',
              key: 'trajectory-training-exporter.icon',
            },
            DatasetIcon,
          ),
        );

        const contextMenus = ctx.get('contextMenus');
        if (contextMenus && localeService) {
          ctx.effect(
            () =>
              contextMenus.register({
                id: 'trajectory-training-exporter.header-menu',
                target: 'sessionHeader',
                order: 110,
                observe: () => [localeService],
                resolve: ({ sessionId }) => [
                  {
                    id: 'export-training-data',
                    label: resolveTranslatedText(localeService, 'menu.exportTraining'),
                    icon: { key: 'trajectory-training-exporter.icon' },
                    run: () => modalState.openForSession(sessionId, 'current'),
                  },
                ],
              }),
            'trajectory-training-exporter: header context menu',
          );
        }

        // 6. Register Sidebar Session Row Menu item
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
          ctx.slots.register(
            {
              name: 'sidebar.workspaces.session.menu.item',
              id: 'trajectory-training-exporter.sidebar-menu',
              order: 50,
              inject: () => ({ modalState, localeService }),
            },
            SidebarSessionMenuItem,
          ),
        );

        // 7. Register Modal Overlay in shell.overlay
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'trajectory-training-exporter.modal',
              order: 50,
              inject: () => ({ modalState, localeService }),
            },
            ExporterModalOverlay,
          ),
        );
      },
    };
  },
});
