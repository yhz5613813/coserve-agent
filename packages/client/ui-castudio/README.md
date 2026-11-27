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

The desktop opens DSH's original conversation and contributes a CAD tab to its right sidebar. There is no separate CAStudio chat or top-level sidebar entry. A CAD project's Session opens that tab automatically only while its right sidebar shows no tab; a tab the user selected, or a sidebar collapsed with its tabs, stays as it is. DSH owns model credentials, requests, tool execution, approvals, cancellation and history through its existing harness. This package uses public UI and Host extension services and does not modify the agent loop.

Choosing a CAD project prepares its existing filesystem directory, registers it as a native DSH Workspace and opens a native Session. The service preserves project instructions and installs the bundled CAD, parametric and simulation skills under `.agents/skills`. Project files remain in the same directory used by the CAD service.

The embedded workspace uses `embedded=1&harness=dsh`, plus `client` (the Session id), `theme` (`light` or `dark`) and `locale` (the active DSH locale id) taken when the frame loads; later theme changes arrive as `castudio:theme` messages without reloading the frame. The frame also receives `castudio:busy` with whether the Session's agent turn is running, on every change and after it reports `castudio:ready`. Its CAD, file, editor, build and simulation surfaces remain available; its legacy Pi conversation and model settings are not used. Files refresh without remounting the editor. Previous Pi transcripts remain on disk but are not converted into native DSH history.

Viewport selections become native file-style reference chips, with the component name and optional face identifier. Repeated picks of the same target do not duplicate the chip. Native editing, deletion, undo and draft persistence apply; submission serializes each retained reference with its geometry context. Sent messages also display compact references. Explicit analysis feedback remains ordinary draft text. Messages are accepted only from the exact iframe window, its origin and its current project. The workbench consumes DSH's resolved theme tokens, font and control radii; theme updates preserve the live editor. The desktop bridge is required; this package does not run another server.

Opening a `.step`, `.stp`, `.stl`, `.glb`, `.gltf`, `.obj`, `.CATPart` or `.CATProduct` file from the file tree or a conversation link shows it in the CAD workspace. The package registers a separate `cad-viewer` tab type for these patterns; its `canOpen` accepts only files of a Session rooted in a CAD project, so every other Session keeps the ordinary preview. The tab holds no content: it records a numbered open request, switches to the CAD tab in its own place and closes itself, and a tab restored by a reload only closes. The CAD frame then receives `{ type: 'castudio:open', projectId, path, part? }`: `path` is relative to the part workspace, and `part` is the slug of a leading `parts/<slug>/` folder (absent for the default part). A request made before the frame reports `castudio:ready` is sent once at that point.

A blank Session in a CAD project shows a compact "Continue an existing part?" card above the composer, in both the hero and the active composer; continuing a part makes the conversation work in that part's folder. Parts are created only in the CAD workbench, so the card offers no way to create one. The card lists the project's parts from `GET /api/projects/:rootId/parts`, the recommended part first, one line per part with its name, status (published, structural or thermal analysis, from the presence of the row's field of that name) and how long ago it changed. The list scrolls when it is long. It stays hidden, and the conversation starts without a part, when the project lists no parts, or has only its root part while that part is unpublished and no other non-blank Session of the workspace exists. The card preselects one part and tags it "Recommended". Each part scores 2 when the most recently reporting CAD workbench of the project (`GET /api/dsh/viewports`) shows it, 2 when the most recently updated non-blank Session of the project worked on it (1 for an older one), and 1 when it has the latest `updatedAt`. The highest score wins; ties go to the more recently updated part, then to the earlier listed one. "Continue selected part" inserts a folder-style part chip at the start of the draft, opens the CAD tab, and sends `castudio:open` with the part slug (`default` for the root part) plus the part's first model file as `path` when it has one. "Don't continue a part" hides the card for that Session. The card disappears once the draft holds a part chip or the Session receives its first message.

The Host face registers the `cadPart` Session projection when `sessionProjections` is present. Its value is `{ projectId, slug, name }` from the latest human `user/message` carrying a valid `<cad-part>` marker, or `null` before one; messages without a marker leave it unchanged. The value is part of Session summaries. Session rows in the sidebar show the part name as a compact trailing badge (`sidebar.session.row.trailing`). The package also registers the `castudio.part` Session subgroup provider, so each workspace groups its Sessions by part with Sessions that name no part last. The recommendation reads the same summary values.

## Simulation-driven CAD optimization

The thermal results page starts a durable CAStudio optimization task. Its Host worker polls the loopback task queue independently of the open view, creates a dedicated Session rooted in the optimization workspace, and runs each design proposal through DSH background jobs and the configured model's `spawn` subagent. Only `structured_output` is admitted for these children; CAStudio constructs, validates, rebinds, solves and scores the proposed CAD independently. Model completion ends one proposal, not the optimization task. The task service owns revisions, claim tokens, attempt limits, fixed physics, ranking, cancellation and recovery.

Host configuration exposes `optimizationEnabled`, `url`, `pollIntervalMs`, `requestTimeoutMs`, `proposalTimeoutMs`, `agentPreset` and `proposalReasoningEffort`. Each proposal defaults to six minutes and `low` reasoning effort while inheriting the parent provider/model; an empty effort inherits the parent setting. This bounds excessive reasoning within the overall optimization budget. A stopped or expired task aborts its running child. Lost proposal responses retry the same attempt and token; the service rejects stale claims. Closing the CAD panel leaves the worker running. Stopping the desktop ends its model jobs; CAStudio detects the lost worker and requires explicit recovery. The existing result-to-conversation action still only appends a draft.

## Model Experience

### User prompts

#### What the model sees

DSH reads the project AGENTS.md and discovers its engineering skills through normal workspace discovery. CAD references serialize as `<cad-selection>` blocks containing the selected project, part slug, file, component and geometry information in the ordinary logged user message. The part slug comes from the iframe selection when the user picks and is fixed in the reference, so a submitted or restored message still names that part after the viewer switches to another one; a selection without a part (a page that predates parts) carries none. A chosen part serializes as `<cad-part>{"projectId","part","name","folder"}</cad-part>` at the start of the first user message, where `folder` is `./` for the root part and `parts/<slug>/` otherwise; the sent message shows it as the part chip. Removed chips contribute no context. CAD tools and HTTP services are invoked with the existing native filesystem and shell tools. No prompt is sent to CAStudio's legacy `/prompt` endpoint.

#### Token effect

Retained geometry references and a part chip add text to the current user message; removing a reference omits that context. Optimization proposals also include frozen constraints and the current task's calculation history.

#### KV Cache effect

References and optimization history are submitted as ordinary message content without rewriting earlier messages. Cache reuse depends on the model provider; changed per-round content is not a reusable prefix.

## Known Limitations and Deferred Work

- Historical Pi chats remain separate files. Existing standalone CAStudio operation is preserved. Non-Chinese locales use the English CAD dictionary.
- The Session list has no filter by part; its search matches only titles, workspaces and Session ids.

### Dev Note

<details>
<summary>Working context for maintainers</summary>

The Host worker lives in `src/optimization-driver.ts`; CAStudio owns the task state in `castudio/server/optimization.ts` at the repository root. Recorded proposal tests use allowlisted model output and do not make provider calls.

</details>
