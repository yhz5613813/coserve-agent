---
description: "CAD project workspaces, geometry references and embedded engineering tools alongside the native DSH conversation."
kind: "package-reference"
---

# CAD workspace in the native DSH conversation

English | [中文](README.zh.md)

## Summary

Open CAD projects beside a native DSH conversation, attach geometry references, and start thermal optimization that continues after closing the view. DSH owns model access and tool permissions; CAStudio validates designs and runs simulations. The desktop bridge and a running CAStudio service are required.

## Table of Contents

- [Workspace behavior](#workspace-behavior)
- [Simulation-driven CAD optimization](#simulation-driven-cad-optimization)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Workspace behavior

The desktop opens DSH's original conversation and contributes a CAD tab to its right sidebar. There is no separate CAStudio chat or top-level sidebar entry. DSH owns model credentials, requests, tool execution, approvals, cancellation and history through its existing harness. This package uses public UI and Host extension services and does not modify the agent loop.

Choosing a CAD project prepares its existing filesystem directory, registers it as a native DSH Workspace and opens a native Session. The service preserves project instructions and installs the bundled CAD, parametric and simulation skills under `.agents/skills`. Project files remain in the same directory used by the CAD service.

The embedded workspace uses `embedded=1&harness=dsh`. Its CAD, file, editor, build and simulation surfaces remain available; its legacy Pi conversation and model settings are not used. Files refresh without remounting the editor. Previous Pi transcripts remain on disk but are not converted into native DSH history.

Viewport selections become native file-style reference chips, with the component name and optional face identifier. Repeated picks of the same target do not duplicate the chip. Native editing, deletion, undo and draft persistence apply; submission serializes each retained reference with its geometry context. Sent messages also display compact references. Explicit analysis feedback remains ordinary draft text. Messages are accepted only from the exact iframe window, its origin and its current project. The workbench consumes DSH's resolved theme tokens, font and control radii; theme updates preserve the live editor. The desktop bridge is required; this package does not run another server.

## Simulation-driven CAD optimization

The thermal results page starts a durable CAStudio optimization task. Its Host worker polls the loopback task queue independently of the open view, creates a dedicated Session rooted in the optimization workspace, and runs each design proposal through DSH background jobs and the configured model's `spawn` subagent. Only `structured_output` is admitted for these children; CAStudio constructs, validates, rebinds, solves and scores the proposed CAD independently. Model completion ends one proposal, not the optimization task. The task service owns revisions, claim tokens, attempt limits, fixed physics, ranking, cancellation and recovery.

Host configuration exposes `optimizationEnabled`, `url`, `pollIntervalMs`, `requestTimeoutMs`, `proposalTimeoutMs`, `agentPreset` and `proposalReasoningEffort`. Each proposal defaults to six minutes and `low` reasoning effort while inheriting the parent provider/model; an empty effort inherits the parent setting. This bounds excessive reasoning within the overall optimization budget. A stopped or expired task aborts its running child. Lost proposal responses retry the same attempt and token; the service rejects stale claims. Closing the CAD panel leaves the worker running. Stopping the desktop ends its model jobs; CAStudio detects the lost worker and requires explicit recovery. The existing result-to-conversation action still only appends a draft.

## Model Experience

### User prompts

#### What the model sees

DSH reads the project AGENTS.md and discovers its engineering skills through normal workspace discovery. CAD references serialize as `<cad-selection>` blocks containing the selected project, file, component and geometry information in the ordinary logged user message. Removed chips contribute no context. CAD tools and HTTP services are invoked with the existing native filesystem and shell tools. No prompt is sent to CAStudio's legacy `/prompt` endpoint.

#### Token effect

Retained geometry references add text to the current user message; removing a reference omits that context. Optimization proposals also include frozen constraints and the current task's calculation history.

#### KV Cache effect

References and optimization history are submitted as ordinary message content without rewriting earlier messages. Cache reuse depends on the model provider; changed per-round content is not a reusable prefix.

## Known Limitations and Deferred Work

- Historical Pi chats remain separate files. Existing standalone CAStudio operation is preserved. Non-Chinese locales use the English CAD dictionary.

### Dev Note

<details>
<summary>Working context for maintainers</summary>

The Host worker lives in `src/optimization-driver.ts`; CAStudio owns the task state in `castudio/server/optimization.ts` at the repository root. Recorded proposal tests use allowlisted model output and do not make provider calls.

</details>
