# CAStudio optimization: recording-derived Host replay

`optimization-real-proposal.json` contains an allowlisted model response from an illustrative heat-sink optimization. Account, project and session identifiers are omitted. The captured model route is `deepseek-flash`; the replay does not call that model.

The fixture contains the actual task prompt, actual `structured_output` arguments (complete Gmsh source, rationale and changes), and the parent's first registered/catalog/settled event sequence. It intentionally excludes model reasoning, system prompts, request tool schemas, credentials, runtime policies and unrelated session events. No model call or `.env` loading is used to replay it.

`optimization-skill-proposal.json` records a real valid candidate from an illustrative optimization task. Its prompt includes the complete packaged `heatsink-optimization` skill v1.0.1 and SHA256. The same production Host replay covers this input and the original pre-skill recording, each with and without a forced forbidden-tool call. This verifies guidance delivery without granting additional tools; the recorded model response is not a fresh model evaluation during replay.

`optimization-recorded.host.spec.ts` mounts production `ui-castudio.apply`, JobsLocal, SubagentRuntime, the shipped in-process spawn provider, AgentLoop, native tool execution, session projections and JSONL child persistence. Only the model adapter and CAStudio HTTP/session/preset API collaborators are fixtures. Parent creation still uses the real AgentLoop. The production Host schedules the job and child and submits the actual recorded proposal. Assertions cover recorded input inclusion, owned parent/child/job relationships, persisted lifecycle ordering, structured tool result, and successful backend submission without a UI.

The second case deliberately prepends a synthetic forbidden tool call to the recorded response. A global filesystem-like test tool is registered, yet the production Host restriction removes it from the model request and the real loop denies its forced invocation without executing it; the next recorded structured proposal succeeds. This injected negative case is not claimed to be a real model recording.

The original recording predates the final global tool visibility restriction and offered additional tools. The replay explicitly verifies the current, narrower tool list contains only `structured_output`; it does not claim those original request schemas match the current runtime.

These are owner-local recording-derived model replay tests, **not** the canonical `test:snapshot` corpus and **not** a CLI/desktop replay. They do not cover dsh profile boot, the full session-controller/preset loader, OS sandbox permissions, real network/model transports, server restarts, or actual GPU solving. A canonical persisted-session snapshot requires a scenario/normalization/CLI harness beyond this bounded task; no fabricated canonical session or unexecuted CLI pass is supplied.

Run from the source root:

```powershell
pnpm exec vitest run packages/client/ui-castudio/tests/optimization-recorded.host.spec.ts packages/client/ui-castudio/tests/optimization.host.spec.ts
```

Coverage: four production Host replay cases plus driver cases for dispatch, retry, cancellation and ownership. The local verification log records the command result.
