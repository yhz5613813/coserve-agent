import type { ProviderProbe as Probe, ProviderProbes as Probes, Settings } from '../shared/types.js';

export type Capabilities = { input: ('text' | 'image')[]; reasoning: boolean };
export type Effort = Exclude<Settings['thinking'], 'off'>;
type Content = string | ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
type Reply = { stopReason: string; errorMessage?: string; content: { type: string; text?: string }[]; usage?: { reasoning?: number } };
/** Sends one user message to the endpoint with the given capability flags; `reasoning` requests that effort level. */
export type Complete = (caps: Capabilities, content: Content, options: { reasoning?: Effort; maxTokens: number; signal: AbortSignal }) => Promise<Reply>;

// 32x32 solid red PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJ0lEQVR42u3NsQkAAAjAsP7/tF7hIASyp6lTCQQCgUAgEAgEgi/BAjLD/C5w/SM9AAAAAElFTkSuQmCC';
const TIMEOUT_MS = 45000;
const replyText = (reply: Reply) => reply.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
const failed = (reply: Reply) => reply.stopReason === 'error' || reply.stopReason === 'aborted';

/**
 * Runs text, image and thinking requests in parallel against one endpoint. A capability is supported when its real request
 * returns normally: text and image need a non-empty reply, thinking only needs the request carrying `effort` to be accepted.
 * `redact` removes secrets from failure messages.
 */
export async function probeCapabilities(complete: Complete, redact: (message: string) => string, effort: Effort = 'low'): Promise<Probes> {
  const call = (caps: Capabilities, content: Content, reasoning?: Effort) => complete(caps, content, { reasoning, maxTokens: 1024, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const reason = (error: unknown) => redact(String((error as Error).message ?? error)).replace(/\s+/g, ' ').slice(0, 160);
  const run = async (task: () => Promise<Omit<Probe, 'ms'>>): Promise<Probe> => {
    const start = Date.now();
    const probe = await task().catch((error: unknown) => ({ ok: false, message: reason(error) }));
    return { ...probe, ms: Date.now() - start };
  };
  const [text, image, reasoning] = await Promise.all([
    run(async () => {
      const reply = await call({ input: ['text'], reasoning: false }, 'Reply with OK only.');
      if (failed(reply)) return { ok: false, message: reason(reply.errorMessage || '请求失败') };
      return replyText(reply) ? { ok: true } : { ok: false, message: '模型没有返回文本' };
    }),
    run(async () => {
      const reply = await call({ input: ['text', 'image'], reasoning: false }, [{ type: 'text', text: 'What colour is this image? Answer with one word.' }, { type: 'image', data: PNG, mimeType: 'image/png' }]);
      if (failed(reply)) return { ok: false, message: `接口拒绝图像输入：${reason(reply.errorMessage || '请求失败')}` };
      return replyText(reply) ? { ok: true } : { ok: false, message: '图像请求没有返回文本' };
    }),
    run(async () => {
      const reply = await call({ input: ['text'], reasoning: true }, 'Reply with OK only.', effort);
      if (failed(reply)) return { ok: false, message: `接口拒绝思考参数：${reason(reply.errorMessage || '请求失败')}` };
      const exposed = reply.content.some(c => c.type === 'thinking') || (reply.usage?.reasoning ?? 0) > 0;
      return { ok: true, message: exposed ? '已返回思考内容' : '接口接受思考参数，未返回思考内容' };
    }),
  ]);
  return { text, image, reasoning };
}
