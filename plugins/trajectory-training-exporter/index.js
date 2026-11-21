import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const name = 'trajectory-training-exporter';
export const inject = ['connection'];

const SESSIONS_ROUTE_PATH = '/api/trajectory-training.sessions';
const EXPORT_ROUTE_PATH = '/api/trajectory-training.export';

const FORMATS = ['openai_chat', 'sharegpt', 'agent_steps', 'raw_trajectory'];
const SOURCE_MODES = ['full_log', 'surface'];
const REASONING_FORMATS = ['field', 'think_tags', 'both', 'none'];

function safeSessionSegment(id) {
  return String(id || 'session').replace(/[^A-Za-z0-9_-]/g, '_');
}

function defaultExportFilename(options, sessionIds) {
  const fmt = options.format || 'openai_chat';
  if (Array.isArray(sessionIds) && sessionIds.length === 1) {
    return `trajectory-${safeSessionSegment(sessionIds[0])}-${fmt}.jsonl`;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `trajectories-${fmt}-${stamp}.jsonl`;
}

function extractTextFromBlocks(blocks, options = {}) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      parts.push(block.text);
    } else if (block.type === 'image' && block.attachment) {
      const ref = block.attachment;
      parts.push(`[Image: ${ref.name || ref.attachmentId || 'image'} (${ref.width || '?'}x${ref.height || '?'})]`);
    } else if (block.type === 'file' && block.attachment) {
      const ref = block.attachment;
      parts.push(`[File: ${ref.name || ref.attachmentId || 'file'} (${ref.bytes || 0} bytes)]`);
    }
  }
  return parts.join('\n\n');
}

function extractReasoningFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'reasoning' && typeof block.text === 'string' && block.text.trim() !== '') {
      parts.push(block.text);
    }
  }
  return parts.join('\n\n');
}

function extractToolCallsFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  const calls = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'tool-call') {
      calls.push({
        id: String(block.id || `call_${calls.length + 1}`),
        name: String(block.name || 'unknown'),
        arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
      });
    }
  }
  return calls;
}

function parseJsonSafe(raw) {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

function formatAssistantContent(text, reasoning, reasoningFormat) {
  const cleanText = typeof text === 'string' ? text : '';
  const cleanReasoning = typeof reasoning === 'string' ? reasoning.trim() : '';
  if (!cleanReasoning || reasoningFormat === 'none') {
    return { content: cleanText, reasoningContent: undefined };
  }
  if (reasoningFormat === 'think_tags') {
    const combined = cleanText
      ? `<think>\n${cleanReasoning}\n</think>\n\n${cleanText}`
      : `<think>\n${cleanReasoning}\n</think>`;
    return { content: combined, reasoningContent: undefined };
  }
  if (reasoningFormat === 'both') {
    const combined = cleanText
      ? `<think>\n${cleanReasoning}\n</think>\n\n${cleanText}`
      : `<think>\n${cleanReasoning}\n</think>`;
    return { content: combined, reasoningContent: cleanReasoning };
  }
  return { content: cleanText, reasoningContent: cleanReasoning };
}

/**
 * Parse one session's raw events or surface events into normalized turns, steps, messages, and stats.
 */
export function parseSessionTrajectory(header, events, fallbackTitle, options = {}) {
  const includeSystem = options.includeSystem !== false;
  const includeTools = options.includeTools !== false;
  const includeReasoning = options.includeReasoning !== false;
  const reasoningFormat = includeReasoning
    ? (REASONING_FORMATS.includes(options.reasoningFormat) ? options.reasoningFormat : 'field')
    : 'none';
  const excludeErrors = options.excludeErrors === true;

  let latestTitle = fallbackTitle || '';
  let latestProvider = '';
  let latestModel = '';
  const toolsByName = new Map();
  const toolNameByCallId = new Map();
  const systemMessages = [];

  const turns = [];
  let currentTurn = null;
  let currentStep = null;

  const ensureTurn = (turnNum) => {
    if (!currentTurn || (turnNum !== undefined && currentTurn.turn !== turnNum)) {
      currentTurn = {
        turn: turnNum ?? (turns.length + 1),
        endReason: 'completed',
        hasError: false,
        events: [],
        steps: [],
      };
      turns.push(currentTurn);
      currentStep = null;
    }
    return currentTurn;
  };

  const ensureStep = (turnNum, stepNum) => {
    const turn = ensureTurn(turnNum);
    if (!currentStep || (stepNum !== undefined && currentStep.step !== stepNum)) {
      currentStep = {
        turn: turn.turn,
        step: stepNum ?? (turn.steps.length + 1),
        preStepMessages: [],
        assistantEvent: null,
        toolCalls: [],
        toolResults: [],
        usage: null,
        time: 0,
      };
      turn.steps.push(currentStep);
    }
    return currentStep;
  };

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const { type, data, time } = event;
    if (!data || typeof data !== 'object') continue;

    switch (type) {
      case 'session/title': {
        if (typeof data.title === 'string' && data.title.trim() !== '') {
          latestTitle = data.title.trim();
        }
        break;
      }
      case 'request/header': {
        const hdr = data.header;
        if (hdr && typeof hdr === 'object') {
          if (hdr.config?.provider) latestProvider = String(hdr.config.provider);
          if (hdr.config?.model) latestModel = String(hdr.config.model);
          if (Array.isArray(hdr.tools)) {
            for (const tool of hdr.tools) {
              if (tool && typeof tool.name === 'string') {
                toolsByName.set(tool.name, {
                  name: tool.name,
                  description: typeof tool.description === 'string' ? tool.description : '',
                  parameters: tool.parameters && typeof tool.parameters === 'object'
                    ? tool.parameters
                    : { type: 'object', properties: {} },
                });
              }
            }
          }
        }
        break;
      }
      case 'request/context': {
        if (data.provider) latestProvider = String(data.provider);
        if (data.model) latestModel = String(data.model);
        break;
      }
      case 'turn/start': {
        currentTurn = {
          turn: typeof data.turn === 'number' ? data.turn : (turns.length + 1),
          endReason: 'completed',
          hasError: false,
          events: [],
          steps: [],
        };
        turns.push(currentTurn);
        currentStep = null;
        break;
      }
      case 'turn/end': {
        if (currentTurn) {
          const kind = data.reason?.kind || 'completed';
          currentTurn.endReason = kind;
          if (kind === 'error' || kind === 'aborted') {
            currentTurn.hasError = true;
          }
        }
        currentTurn = null;
        currentStep = null;
        break;
      }
      case 'step/start': {
        const turn = ensureTurn(data.turn);
        currentStep = {
          turn: turn.turn,
          step: typeof data.step === 'number' ? data.step : (turn.steps.length + 1),
          preStepMessages: [],
          assistantEvent: null,
          toolCalls: [],
          toolResults: [],
          usage: null,
          time: time || 0,
        };
        turn.steps.push(currentStep);
        break;
      }
      case 'step/end': {
        currentStep = null;
        break;
      }
      case 'system/message': {
        if (event.surfaceOp && event.surfaceOp !== 'append') break;
        const text = extractTextFromBlocks(data.message?.content);
        if (text) {
          systemMessages.push({ role: 'system', content: text, seq: event.seq });
        }
        break;
      }
      case 'developer/message': {
        if (event.surfaceOp && event.surfaceOp !== 'append') break;
        const text = extractTextFromBlocks(data.message?.content);
        if (text) {
          systemMessages.push({ role: 'developer', content: text, seq: event.seq });
        }
        break;
      }
      case 'user/message': {
        if (event.surfaceOp && event.surfaceOp !== 'append') break;
        const contentBlocks = Array.isArray(data.content) ? data.content : data.message?.content;
        const text = extractTextFromBlocks(contentBlocks);
        if (text) {
          const turn = ensureTurn();
          const userMsg = { role: 'user', content: text, seq: event.seq, time: time || 0 };
          turn.events.push({ kind: 'user', message: userMsg });
          if (currentStep && !currentStep.assistantEvent) {
            currentStep.preStepMessages.push(userMsg);
          }
        }
        break;
      }
      case 'assistant/message': {
        if (event.surfaceOp && event.surfaceOp !== 'append') break;
        const msg = data.message;
        if (!msg || typeof msg !== 'object') break;
        if (msg.source?.provider) latestProvider = String(msg.source.provider);
        if (msg.source?.model) latestModel = String(msg.source.model);

        const text = extractTextFromBlocks(msg.content);
        const reasoning = extractReasoningFromBlocks(msg.content);
        const calls = extractToolCallsFromBlocks(msg.content);
        for (const c of calls) {
          toolNameByCallId.set(c.id, c.name);
        }

        const turn = ensureTurn(data.turn);
        const step = ensureStep(data.turn, data.step);
        if (step.assistantEvent) {
          currentStep = null;
        }
        const targetStep = ensureStep(data.turn, data.step);
        const assistantData = {
          text,
          reasoning,
          toolCalls: calls,
          usage: data.usage || null,
          interrupted: data.interrupted === true,
          seq: event.seq,
          time: time || 0,
        };
        targetStep.assistantEvent = assistantData;
        targetStep.toolCalls = calls;
        targetStep.usage = data.usage || null;
        targetStep.time = time || targetStep.time;
        turn.events.push({ kind: 'assistant', step: targetStep, data: assistantData });
        break;
      }
      case 'tool/call': {
        const callId = String(data.callId || '');
        const toolName = String(data.name || 'unknown');
        if (callId) toolNameByCallId.set(callId, toolName);
        break;
      }
      case 'tool/result': {
        if (event.surfaceOp && event.surfaceOp !== 'append') break;
        const msg = data.message;
        if (!msg || typeof msg !== 'object') break;
        const callId = String(msg.toolCallId || msg.source?.callId || '');
        const toolName = toolNameByCallId.get(callId) || 'tool';
        const text = extractTextFromBlocks(msg.content);
        const isError = msg.isError === true || Boolean(data.error);
        const errorReason = data.error?.reason || '';
        const finalContent = isError && errorReason && !text.includes(errorReason)
          ? (text ? `Error: ${errorReason}\n\n${text}` : `Error: ${errorReason}`)
          : text;

        const turn = ensureTurn(data.turn);
        const step = turn.steps[turn.steps.length - 1] || ensureStep(data.turn, data.step);
        const resultData = {
          toolCallId: callId,
          name: toolName,
          content: finalContent,
          isError,
          seq: event.seq,
          time: time || 0,
        };
        step.toolResults.push(resultData);
        if (isError) turn.hasError = true;
        turn.events.push({ kind: 'tool_result', data: resultData });
        break;
      }
      default:
        break;
    }
  }

  // Deduplicate system/developer messages by content
  const uniqueSystemMessages = [];
  const seenSystem = new Set();
  if (includeSystem) {
    for (const sm of systemMessages) {
      const key = `${sm.role}:${sm.content}`;
      if (!seenSystem.has(key)) {
        seenSystem.add(key);
        uniqueSystemMessages.push({
          role: sm.role === 'developer' ? 'system' : sm.role,
          content: sm.content,
        });
      }
    }
  }

  const toolsList = includeTools ? Array.from(toolsByName.values()) : [];
  const openAiTools = toolsList.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));

  const validTurns = turns.filter((t) => {
    if (t.events.length === 0) return false;
    if (excludeErrors && t.hasError) return false;
    return true;
  });

  // Compute statistics
  let stepCount = 0;
  let toolCallCount = 0;
  let toolErrorCount = 0;
  let reasoningCharCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const t of validTurns) {
    for (const s of t.steps) {
      if (s.assistantEvent) {
        stepCount += 1;
        toolCallCount += s.toolCalls.length;
        reasoningCharCount += (s.assistantEvent.reasoning || '').length;
        if (s.usage) {
          totalInputTokens += Number(s.usage.inputTokens || 0);
          totalOutputTokens += Number(s.usage.outputTokens || 0);
        }
      }
      for (const tr of s.toolResults) {
        if (tr.isError) toolErrorCount += 1;
      }
    }
  }

  const buildOpenAiMessagesForTurns = (turnSlice) => {
    const msgs = [...uniqueSystemMessages];
    for (const turn of turnSlice) {
      for (const item of turn.events) {
        if (item.kind === 'user') {
          msgs.push({
            role: 'user',
            content: item.message.content,
          });
        } else if (item.kind === 'assistant') {
          const a = item.data;
          const formatted = formatAssistantContent(a.text, a.reasoning, reasoningFormat);
          const msgObj = {
            role: 'assistant',
            content: formatted.content === '' && a.toolCalls.length > 0 ? null : formatted.content,
          };
          if (formatted.reasoningContent !== undefined) {
            msgObj.reasoning_content = formatted.reasoningContent;
          }
          if (a.toolCalls.length > 0) {
            msgObj.tool_calls = a.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: tc.arguments,
              },
            }));
          }
          msgs.push(msgObj);
        } else if (item.kind === 'tool_result') {
          const tr = item.data;
          msgs.push({
            role: 'tool',
            tool_call_id: tr.toolCallId,
            name: tr.name,
            content: tr.content,
          });
        }
      }
    }
    return msgs;
  };

  const buildShareGptForTurns = (turnSlice) => {
    const conversations = [];
    for (const turn of turnSlice) {
      for (const item of turn.events) {
        if (item.kind === 'user') {
          conversations.push({
            from: 'human',
            value: item.message.content,
          });
        } else if (item.kind === 'assistant') {
          const a = item.data;
          const thinkMode = includeReasoning ? 'think_tags' : 'none';
          const { content } = formatAssistantContent(a.text, a.reasoning, thinkMode);
          if (a.toolCalls.length === 0) {
            conversations.push({
              from: 'gpt',
              value: content,
            });
          } else {
            for (let i = 0; i < a.toolCalls.length; i++) {
              const tc = a.toolCalls[i];
              const callPayload = {
                name: tc.name,
                arguments: parseJsonSafe(tc.arguments),
              };
              if (i === 0 && content.trim() !== '') {
                callPayload.thought = content;
              }
              conversations.push({
                from: 'function_call',
                value: JSON.stringify(callPayload),
              });
            }
          }
        } else if (item.kind === 'tool_result') {
          conversations.push({
            from: 'observation',
            value: item.data.content,
          });
        }
      }
    }
    return conversations;
  };

  const baseMetadata = {
    session_id: String(header.id),
    ...(header.parentSession ? { parent_session_id: String(header.parentSession) } : {}),
    ...(header.origin ? { origin: header.origin } : {}),
    delegation_depth: header.delegationDepth ?? 0,
    ...(header.agentPreset ? { agent_preset: header.agentPreset } : {}),
    ...(header.cwd ? { cwd: header.cwd } : {}),
    title: latestTitle || 'Untitled Session',
    created_at: header.createdAt,
    provider: latestProvider || undefined,
    model: latestModel || undefined,
    turn_count: validTurns.length,
    step_count: stepCount,
    tool_call_count: toolCallCount,
    tool_error_count: toolErrorCount,
    reasoning_char_count: reasoningCharCount,
    total_input_tokens: totalInputTokens,
    total_output_tokens: totalOutputTokens,
  };

  return {
    header,
    title: latestTitle || 'Untitled Session',
    systemMessages: uniqueSystemMessages,
    toolsList,
    openAiTools,
    validTurns,
    baseMetadata,
    buildOpenAiMessagesForTurns,
    buildShareGptForTurns,
  };
}

/**
 * Convert a parsed session trajectory into training sample objects according to options.format.
 */
export function buildTrainingSamples(parsed, options = {}) {
  const format = FORMATS.includes(options.format) ? options.format : 'openai_chat';
  const splitByTurn = options.splitByTurn === true;
  const includeTools = options.includeTools !== false;
  const includeSystem = options.includeSystem !== false;
  const includeReasoning = options.includeReasoning !== false;
  const reasoningFormat = includeReasoning
    ? (REASONING_FORMATS.includes(options.reasoningFormat) ? options.reasoningFormat : 'field')
    : 'none';

  const {
    header,
    systemMessages,
    toolsList,
    openAiTools,
    validTurns,
    baseMetadata,
    buildOpenAiMessagesForTurns,
    buildShareGptForTurns,
  } = parsed;

  if (validTurns.length === 0) return [];

  if (format === 'openai_chat') {
    const turnGroups = splitByTurn ? validTurns.map((t) => [t]) : [validTurns];
    return turnGroups
      .map((group) => {
        const messages = buildOpenAiMessagesForTurns(group);
        if (messages.length === 0) return null;
        const sampleId = splitByTurn
          ? `${header.id}:turn-${group[0].turn}`
          : String(header.id);
        return {
          id: sampleId,
          messages,
          ...(includeTools && openAiTools.length > 0 ? { tools: openAiTools } : {}),
          metadata: {
            ...baseMetadata,
            ...(splitByTurn ? { turn: group[0].turn } : {}),
          },
        };
      })
      .filter(Boolean);
  }

  if (format === 'sharegpt') {
    const systemText = includeSystem
      ? systemMessages.map((m) => m.content).join('\n\n')
      : '';
    const toolsJson = includeTools && toolsList.length > 0
      ? JSON.stringify(toolsList)
      : undefined;
    const turnGroups = splitByTurn ? validTurns.map((t) => [t]) : [validTurns];
    return turnGroups
      .map((group) => {
        const conversations = buildShareGptForTurns(group);
        if (conversations.length === 0) return null;
        const sampleId = splitByTurn
          ? `${header.id}:turn-${group[0].turn}`
          : String(header.id);
        return {
          id: sampleId,
          ...(systemText ? { system: systemText } : {}),
          ...(toolsJson ? { tools: toolsJson } : {}),
          conversations,
          metadata: {
            ...baseMetadata,
            ...(splitByTurn ? { turn: group[0].turn } : {}),
          },
        };
      })
      .filter(Boolean);
  }

  if (format === 'agent_steps') {
    const samples = [];
    const runningMessages = [...systemMessages];

    for (const turn of validTurns) {
      let pendingUserMessages = [];
      for (const ev of turn.events) {
        if (ev.kind === 'user') {
          pendingUserMessages.push({
            role: 'user',
            content: ev.message.content,
          });
        } else if (ev.kind === 'assistant') {
          for (const um of pendingUserMessages) {
            runningMessages.push(um);
          }
          pendingUserMessages = [];

          const step = ev.step;
          const a = ev.data;
          const promptSnapshot = runningMessages.map((m) => ({ ...m }));
          const formatted = formatAssistantContent(a.text, a.reasoning, reasoningFormat);
          const actionMsg = {
            role: 'assistant',
            content: formatted.content === '' && a.toolCalls.length > 0 ? null : formatted.content,
            ...(formatted.reasoningContent !== undefined ? { reasoning_content: formatted.reasoningContent } : {}),
            ...(a.toolCalls.length > 0
              ? {
                  tool_calls: a.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: tc.arguments },
                  })),
                }
              : {}),
          };

          const observations = step.toolResults.map((tr) => ({
            tool_call_id: tr.toolCallId,
            name: tr.name,
            content: tr.content,
            is_error: tr.isError,
          }));

          const stepHasToolError = step.toolResults.some((tr) => tr.isError);
          const reward = turn.hasError
            ? (stepHasToolError ? 0.0 : 0.5)
            : 1.0;
          const isLastStepInTurn = turn.steps[turn.steps.length - 1] === step;

          samples.push({
            id: `${header.id}:t${turn.turn}:s${step.step}`,
            session_id: String(header.id),
            turn: turn.turn,
            step: step.step,
            prompt_messages: promptSnapshot,
            ...(includeTools && openAiTools.length > 0 ? { tools: openAiTools } : {}),
            action: actionMsg,
            observations,
            usage: a.usage || null,
            reward,
            done: isLastStepInTurn,
            metadata: {
              title: baseMetadata.title,
              provider: baseMetadata.provider,
              model: baseMetadata.model,
              turn_end_reason: turn.endReason,
              timestamp: a.time || header.createdAt,
            },
          });

          runningMessages.push(actionMsg);
          for (const tr of step.toolResults) {
            runningMessages.push({
              role: 'tool',
              tool_call_id: tr.toolCallId,
              name: tr.name,
              content: tr.content,
            });
          }
        }
      }
    }
    return samples;
  }

  // format === 'raw_trajectory'
  return [
    {
      id: String(header.id),
      header: {
        version: header.version,
        id: String(header.id),
        createdAt: header.createdAt,
        cwd: header.cwd,
        parentSession: header.parentSession ? String(header.parentSession) : undefined,
        origin: header.origin,
        delegationDepth: header.delegationDepth ?? 0,
        agentPreset: header.agentPreset,
      },
      title: baseMetadata.title,
      system_prompts: systemMessages,
      tools: toolsList,
      turns: validTurns.map((t) => ({
        turn: t.turn,
        end_reason: t.endReason,
        has_error: t.hasError,
        user_messages: t.events
          .filter((e) => e.kind === 'user')
          .map((e) => ({ content: e.message.content, seq: e.message.seq, time: e.message.time })),
        steps: t.steps
          .filter((s) => s.assistantEvent !== null)
          .map((s) => ({
            step: s.step,
            time: s.time,
            assistant: {
              content: s.assistantEvent.text,
              ...(includeReasoning && s.assistantEvent.reasoning
                ? { reasoning_content: s.assistantEvent.reasoning }
                : {}),
              tool_calls: s.toolCalls,
              interrupted: s.assistantEvent.interrupted,
            },
            tool_results: s.toolResults,
            usage: s.usage,
          })),
      })),
      messages: buildOpenAiMessagesForTurns(validTurns),
      stats: baseMetadata,
    },
  ];
}

/**
 * Shared Host service class for listing saved trajectories and exporting trainable datasets.
 */
class TrajectoryTrainingExporterService {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async flushIfLive(sessionId, signal) {
    signal?.throwIfAborted();
    const sessions = this.ctx.get('sessions');
    if (!sessions) return;
    const live = sessions.get(sessionId);
    if (!live) return;
    await sessions.flush(live);
    signal?.throwIfAborted();
  }

  /**
   * List all saved and live sessions with titles and lineage metadata.
   */
  async listSessions(options = {}, signal) {
    const sessionQuery = this.ctx.get('sessionQuery');
    if (!sessionQuery) {
      throw new Error('sessionQuery service is unavailable in this profile');
    }
    const records = await sessionQuery.listSessions(signal);
    const includeSubagents = options.includeSubagents !== false;
    const filteredRecords = includeSubagents
      ? records
      : records.filter((r) => r.header.origin !== 'subagent' && !r.header.parentSession);

    const ids = filteredRecords.map((r) => r.header.id);
    const titleResults = ids.length > 0
      ? await sessionQuery.readTitleSnapshots(ids, signal)
      : [];
    const titleMap = new Map();
    for (const tr of titleResults) {
      if (tr.status === 'fulfilled' && tr.value.title?.title) {
        titleMap.set(String(tr.sessionId), tr.value.title.title);
      }
    }

    const items = filteredRecords.map((record) => {
      const h = record.header;
      const id = String(h.id);
      return {
        sessionId: id,
        title: titleMap.get(id) || (h.origin === 'subagent' ? `Subagent (${id.slice(0, 8)})` : `Session (${id.slice(0, 8)})`),
        createdAt: h.createdAt,
        cwd: h.cwd || null,
        parentSession: h.parentSession ? String(h.parentSession) : null,
        origin: h.origin || 'root',
        delegationDepth: h.delegationDepth ?? 0,
        agentPreset: h.agentPreset || null,
        live: Boolean(record.live),
        persisted: Boolean(record.persisted),
      };
    });

    return {
      total: items.length,
      sessions: items,
    };
  }

  /**
   * Expand requested sessionIds with descendant subagent sessions when includeSubagents is true.
   */
  async resolveTargetSessionIds(rawSessionIds, includeSubagents, signal) {
    const sessionQuery = this.ctx.get('sessionQuery');
    if (!sessionQuery) {
      throw new Error('sessionQuery service is unavailable in this profile');
    }

    let baseIds = [];
    if (!rawSessionIds || rawSessionIds === 'all' || (Array.isArray(rawSessionIds) && rawSessionIds.length === 0)) {
      const records = await sessionQuery.listSessions(signal);
      baseIds = records
        .filter((r) => includeSubagents || (!r.header.parentSession && r.header.origin !== 'subagent'))
        .map((r) => String(r.header.id));
    } else if (typeof rawSessionIds === 'string') {
      baseIds = [rawSessionIds];
    } else if (Array.isArray(rawSessionIds)) {
      baseIds = rawSessionIds.map((id) => String(id).trim()).filter(Boolean);
    }

    const orderedIds = [];
    const seen = new Set();
    const addId = (id) => {
      if (id && !seen.has(id)) {
        seen.add(id);
        orderedIds.push(id);
      }
    };

    const walkDescendants = (nodes) => {
      if (!Array.isArray(nodes)) return;
      for (const node of nodes) {
        if (node?.session?.header?.id) {
          addId(String(node.session.header.id));
        }
        if (Array.isArray(node?.descendants)) {
          walkDescendants(node.descendants);
        }
      }
    };

    for (const id of baseIds) {
      addId(id);
      if (includeSubagents) {
        try {
          const trace = await sessionQuery.traceSession(id, signal);
          walkDescendants(trace.descendants);
        } catch {
          // Ignore lineage trace errors for isolated/missing sessions
        }
      }
    }

    return orderedIds;
  }

  /**
   * Convert and optionally save training dataset JSONL from saved/live trajectories.
   */
  async exportDataset(options = {}, signal) {
    const sessionQuery = this.ctx.get('sessionQuery');
    if (!sessionQuery) {
      throw new Error('sessionQuery service is unavailable in this profile');
    }

    const format = FORMATS.includes(options.format) ? options.format : 'openai_chat';
    const sourceMode = SOURCE_MODES.includes(options.sourceMode) ? options.sourceMode : 'full_log';
    const includeSubagents = options.includeSubagents !== false;
    const includeReasoning = options.includeReasoning !== false;
    const includeSystem = options.includeSystem !== false;
    const includeTools = options.includeTools !== false;
    const splitByTurn = options.splitByTurn === true;
    const excludeErrors = options.excludeErrors === true;
    const reasoningFormat = REASONING_FORMATS.includes(options.reasoningFormat)
      ? options.reasoningFormat
      : 'field';

    const targetIds = await this.resolveTargetSessionIds(
      options.sessionIds,
      includeSubagents,
      signal,
    );

    const titleResults = targetIds.length > 0
      ? await sessionQuery.readTitleSnapshots(targetIds, signal)
      : [];
    const titleMap = new Map();
    for (const tr of titleResults) {
      if (tr.status === 'fulfilled' && tr.value.title?.title) {
        titleMap.set(String(tr.sessionId), tr.value.title.title);
      }
    }

    const allSamples = [];
    const sessionSummaries = [];
    let firstCwd = null;

    for (const id of targetIds) {
      signal?.throwIfAborted();
      await this.flushIfLive(id, signal);

      let snapshot;
      try {
        snapshot = sourceMode === 'surface'
          ? await sessionQuery.readSurface(id)
          : await sessionQuery.readSession(id);
      } catch {
        continue;
      }

      if (!firstCwd && snapshot.session?.cwd) {
        firstCwd = snapshot.session.cwd;
      }

      const parsed = parseSessionTrajectory(
        snapshot.session,
        snapshot.events,
        titleMap.get(id),
        {
          includeSystem,
          includeTools,
          includeReasoning,
          reasoningFormat,
          excludeErrors,
        },
      );

      const samples = buildTrainingSamples(parsed, {
        format,
        splitByTurn,
        includeTools,
        includeSystem,
        includeReasoning,
        reasoningFormat,
      });

      if (samples.length > 0) {
        allSamples.push(...samples);
        sessionSummaries.push({
          sessionId: id,
          title: parsed.title,
          sampleCount: samples.length,
          turnCount: parsed.baseMetadata.turn_count,
          stepCount: parsed.baseMetadata.step_count,
          toolCallCount: parsed.baseMetadata.tool_call_count,
          reasoningCharCount: parsed.baseMetadata.reasoning_char_count,
        });
      }
    }

    const jsonlLines = allSamples.map((s) => JSON.stringify(s));
    const jsonlContent = jsonlLines.length > 0 ? `${jsonlLines.join('\n')}\n` : '';
    const filename = defaultExportFilename({ format }, targetIds);

    let savedPath = null;
    let bytesWritten = 0;

    if (typeof options.outputPath === 'string' && options.outputPath.trim() !== '') {
      const rawOut = options.outputPath.trim();
      const baseDir = options.baseCwd
        || firstCwd
        || this.ctx.get('workingDirectory')?.defaultDirectory
        || process.cwd();
      const resolvedPath = path.isAbsolute(rawOut)
        ? rawOut
        : path.resolve(baseDir, rawOut);
      await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
      const buf = Buffer.from(jsonlContent, 'utf8');
      await fs.writeFile(resolvedPath, buf);
      savedPath = resolvedPath;
      bytesWritten = buf.byteLength;
    }

    const stats = {
      format,
      sourceMode,
      requestedSessionCount: targetIds.length,
      exportedSessionCount: sessionSummaries.length,
      sampleCount: allSamples.length,
      totalTurns: sessionSummaries.reduce((acc, s) => acc + s.turnCount, 0),
      totalSteps: sessionSummaries.reduce((acc, s) => acc + s.stepCount, 0),
      totalToolCalls: sessionSummaries.reduce((acc, s) => acc + s.toolCallCount, 0),
      totalReasoningChars: sessionSummaries.reduce((acc, s) => acc + s.reasoningCharCount, 0),
      byteLength: Buffer.byteLength(jsonlContent, 'utf8'),
    };

    return {
      filename,
      savedPath,
      bytesWritten,
      stats,
      sessions: sessionSummaries,
      samples: allSamples,
      jsonlContent,
    };
  }
}

export function apply(ctx) {
  const service = new TrajectoryTrainingExporterService(ctx);
  ctx.provide('trajectoryTrainingExporter', service);

  // 1. Register HTTP GET route for listing saved sessions
  ctx.effect(() => ctx.connection.fetch.register({
    path: SESSIONS_ROUTE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url);
        const includeSubagents = url.searchParams.get('includeSubagents') !== 'false';
        const result = await service.listSessions({ includeSubagents }, request.signal);
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
    },
  }), 'trajectory-training-exporter: sessions route');

  // 2. Register HTTP GET/HEAD/POST route for exporting, previewing, and saving training datasets
  ctx.effect(() => ctx.connection.fetch.register({
    path: EXPORT_ROUTE_PATH,
    methods: ['GET', 'HEAD', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const action = body.action || 'preview';
          const maxPreviewSamples = typeof body.maxPreviewSamples === 'number' ? body.maxPreviewSamples : 10;

          if (action === 'list') {
            const listResult = await service.listSessions(body, request.signal);
            return new Response(JSON.stringify({ ok: true, ...listResult }), {
              status: 200,
              headers: { 'content-type': 'application/json; charset=utf-8' },
            });
          }

          const exportOptions = {
            sessionIds: body.sessionIds,
            format: body.format,
            sourceMode: body.sourceMode,
            includeSubagents: body.includeSubagents,
            includeReasoning: body.includeReasoning,
            reasoningFormat: body.reasoningFormat,
            includeSystem: body.includeSystem,
            includeTools: body.includeTools,
            splitByTurn: body.splitByTurn,
            excludeErrors: body.excludeErrors,
            outputPath: action === 'save'
              ? (body.outputPath || defaultExportFilename({ format: body.format }, Array.isArray(body.sessionIds) ? body.sessionIds : []))
              : undefined,
          };

          const result = await service.exportDataset(exportOptions, request.signal);
          const previewLines = result.samples
            .slice(0, maxPreviewSamples)
            .map((s) => JSON.stringify(s, null, 2));

          return new Response(
            JSON.stringify({
              ok: true,
              filename: result.filename,
              savedPath: result.savedPath,
              bytesWritten: result.bytesWritten,
              stats: result.stats,
              sessions: result.sessions,
              previewSamples: result.samples.slice(0, maxPreviewSamples),
              previewText: previewLines.join('\n\n'),
              jsonlContent: body.includeFullContent ? result.jsonlContent : undefined,
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json; charset=utf-8' },
            },
          );
        }

        // GET / HEAD download route
        const url = new URL(request.url);
        const params = url.searchParams;
        const sessionIdsParam = params.get('sessionIds') || params.get('sessionId') || 'all';
        const sessionIds = sessionIdsParam === 'all'
          ? 'all'
          : sessionIdsParam.split(',').map((s) => s.trim()).filter(Boolean);

        const result = await service.exportDataset(
          {
            sessionIds,
            format: params.get('format') || 'openai_chat',
            sourceMode: params.get('sourceMode') || 'full_log',
            includeSubagents: params.get('includeSubagents') !== 'false',
            includeReasoning: params.get('includeReasoning') !== 'false',
            reasoningFormat: params.get('reasoningFormat') || 'field',
            includeSystem: params.get('includeSystem') !== 'false',
            includeTools: params.get('includeTools') !== 'false',
            splitByTurn: params.get('splitByTurn') === 'true',
            excludeErrors: params.get('excludeErrors') === 'true',
          },
          request.signal,
        );

        const headers = {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'content-disposition': `attachment; filename="${result.filename}"`,
          'x-exported-samples': String(result.stats.sampleCount),
          'x-exported-sessions': String(result.stats.exportedSessionCount),
        };

        if (request.method === 'HEAD') {
          return new Response(null, { status: 200, headers });
        }
        return new Response(result.jsonlContent, { status: 200, headers });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return new Response(message, { status: 500 });
      }
    },
  }), 'trajectory-training-exporter: export route');

  // 3. Register /train-export command when commands service is available
  ctx.inject(['commands'], (cmdCtx) => {
    cmdCtx.effect(() => cmdCtx.commands.register({
      name: 'train-export',
      description: 'Export saved trajectory into trainable agent dataset JSONL (openai_chat, sharegpt, agent_steps, raw_trajectory)',
      input: {
        hint: '[openai_chat|sharegpt|agent_steps|raw_trajectory] [output-file.jsonl]',
      },
      handler: async (invocation) => {
        try {
          const tokens = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
          let format = 'openai_chat';
          let outputPath = '';
          for (const tok of tokens) {
            if (FORMATS.includes(tok)) {
              format = tok;
            } else if (!outputPath) {
              outputPath = tok;
            }
          }
          const sessionId = String(invocation.agent.id);
          const sessionObj = ctx.get('sessions')?.get(invocation.agent.id);
          const baseCwd = sessionObj?.header?.cwd || ctx.get('workingDirectory')?.defaultDirectory;
          const finalOut = outputPath || defaultExportFilename({ format }, [sessionId]);

          const result = await service.exportDataset(
            {
              sessionIds: [sessionId],
              format,
              includeSubagents: true,
              outputPath: finalOut,
              baseCwd,
            },
            invocation.signal,
          );

          return {
            kind: 'success',
            text: `Exported ${result.stats.sampleCount} trainable sample(s) (${format}) from ${result.stats.exportedSessionCount} session(s) to ${result.savedPath}.`,
          };
        } catch (error) {
          return {
            kind: 'error',
            text: error instanceof Error ? error.message : String(error),
          };
        }
      },
    }), 'trajectory-training-exporter: /train-export command');
  });

  // 4. Register model-facing tool export_training_trajectory when tools service is available
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register({
      name: 'export_training_trajectory',
      description: 'List saved session trajectories, preview converted agent training samples, or export saved trajectories to a JSONL dataset file for agent fine-tuning and RL.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'preview', 'export'],
            description: 'Operation to perform: list saved trajectories, preview converted samples, or export to a JSONL file.',
          },
          session_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Session IDs to export or preview. Omit or pass ["all"] to include all saved sessions, or ["current"] for the active session.',
          },
          format: {
            type: 'string',
            enum: FORMATS,
            description: 'Target training data format: openai_chat (OpenAI/TRL/verl Chat & Tool SFT), sharegpt (LLaMA-Factory ShareGPT), agent_steps (step-wise RL/GRPO/PRM), or raw_trajectory. Defaults to openai_chat.',
          },
          source_mode: {
            type: 'string',
            enum: SOURCE_MODES,
            description: 'Event source: full_log (complete committed trajectory) or surface (post-compaction active surface). Defaults to full_log.',
          },
          include_reasoning: {
            type: 'boolean',
            description: 'Include model reasoning traces (reasoning_content / <think>). Defaults to true.',
          },
          reasoning_format: {
            type: 'string',
            enum: REASONING_FORMATS,
            description: 'How reasoning is serialized in openai_chat/agent_steps: field (reasoning_content), think_tags (<think>...</think> in content), both, or none. Defaults to field.',
          },
          include_system: {
            type: 'boolean',
            description: 'Include system and developer instructions. Defaults to true.',
          },
          include_tools: {
            type: 'boolean',
            description: 'Include tool schemas in exported records. Defaults to true.',
          },
          include_subagents: {
            type: 'boolean',
            description: 'Include descendant subagent trajectories. Defaults to true.',
          },
          split_by_turn: {
            type: 'boolean',
            description: 'Emit one training sample per turn instead of one multi-turn sample per session. Defaults to false.',
          },
          exclude_errors: {
            type: 'boolean',
            description: 'Skip turns that ended in error or abort. Defaults to false.',
          },
          output_path: {
            type: 'string',
            description: 'Destination JSONL file path for export action; relative paths resolve against the current working directory.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['action'],
          properties: {
            action: { type: 'string' },
            total_sessions: { type: 'integer' },
            sessions: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
              },
            },
            saved_path: { type: 'string' },
            bytes_written: { type: 'integer' },
            stats: {
              type: 'object',
              additionalProperties: true,
            },
            preview_samples: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
              },
            },
          },
        },
        render(_args, value) {
          if (value.action === 'list') {
            const lines = (value.sessions || []).slice(0, 30).map(
              (s) => `- ${s.sessionId} | "${s.title}" | origin=${s.origin} | live=${s.live}`,
            );
            return [{
              type: 'text',
              text: `Found ${value.total_sessions || 0} saved trajectory session(s):\n${lines.join('\n')}`,
            }];
          }
          if (value.action === 'preview') {
            return [{
              type: 'text',
              text: `Previewed ${value.stats?.sampleCount || 0} training sample(s) (${value.stats?.format}) from ${value.stats?.exportedSessionCount || 0} session(s).\nSample preview:\n${JSON.stringify((value.preview_samples || [])[0] || null, null, 2).slice(0, 2000)}`,
            }];
          }
          return [{
            type: 'text',
            text: `Exported ${value.stats?.sampleCount || 0} trainable sample(s) (${value.stats?.format}) from ${value.stats?.exportedSessionCount || 0} session(s) to ${value.saved_path} (${value.bytes_written || 0} bytes).`,
          }];
        },
      },
      async execute(args, exec) {
        const input = args && typeof args === 'object' ? args : { action: 'list' };
        const action = input.action || 'list';

        if (action === 'list') {
          const listRes = await service.listSessions(
            { includeSubagents: input.include_subagents !== false },
            exec.signal,
          );
          return {
            action: 'list',
            total_sessions: listRes.total,
            sessions: listRes.sessions,
          };
        }

        const callerSessionId = exec.agent?.id ? String(exec.agent.id) : undefined;
        let sessionIds = input.session_ids;
        if (!sessionIds || sessionIds.length === 0) {
          sessionIds = callerSessionId ? [callerSessionId] : 'all';
        } else if (Array.isArray(sessionIds)) {
          if (sessionIds.includes('all')) {
            sessionIds = 'all';
          } else {
            sessionIds = sessionIds.map((id) => (id === 'current' && callerSessionId ? callerSessionId : id));
          }
        }

        const format = input.format || 'openai_chat';
        const sessionObj = callerSessionId ? ctx.get('sessions')?.get(callerSessionId) : undefined;
        const baseCwd = (sessionObj && ctx.get('workingDirectory')?.get(sessionObj))
          || sessionObj?.header?.cwd
          || ctx.get('workingDirectory')?.defaultDirectory
          || process.cwd();

        const outputPath = action === 'export'
          ? (input.output_path || defaultExportFilename({ format }, Array.isArray(sessionIds) ? sessionIds : []))
          : undefined;

        const res = await service.exportDataset(
          {
            sessionIds,
            format,
            sourceMode: input.source_mode || 'full_log',
            includeReasoning: input.include_reasoning !== false,
            reasoningFormat: input.reasoning_format || 'field',
            includeSystem: input.include_system !== false,
            includeTools: input.include_tools !== false,
            includeSubagents: input.include_subagents !== false,
            splitByTurn: input.split_by_turn === true,
            excludeErrors: input.exclude_errors === true,
            outputPath,
            baseCwd,
          },
          exec.signal,
        );

        return {
          action,
          ...(res.savedPath ? { saved_path: res.savedPath, bytes_written: res.bytesWritten } : {}),
          stats: res.stats,
          sessions: res.sessions,
          preview_samples: res.samples.slice(0, 3),
        };
      },
      presentCall(args) {
        const input = args && typeof args === 'object' ? args : {};
        return {
          card: 'generic',
          title: `Trajectory training dataset (${input.action || 'export'})`,
          kind: 'other',
          rawInput: args,
        };
      },
    }), 'trajectory-training-exporter: export_training_trajectory tool');
  });
}
