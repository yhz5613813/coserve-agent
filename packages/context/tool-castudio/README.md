---
description: "The model-facing cad_workbench tool for the live CAStudio CAD workbench: inspect viewport state, select parts, adjust the camera and display, switch workspaces, and save viewport snapshots, for users and maintainers choosing, configuring, or debugging the tool."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-castudio

English | [中文](README.zh.md)

## Summary

`dsh-tool-castudio` gives the agent a `cad_workbench` tool for the CAD workbench the user has open in CAStudio. The tool reads which workbenches are live, inspects the three.js viewport state (model, parts, selection, display options, camera), frames the model, selects parts and CAD faces by id or exact name, toggles part visibility, changes display options and the workspace tab, and saves a real viewport PNG the agent can then view with `read_image`. It talks only to the loopback CAStudio service and changes view state; the only file produced is the snapshot PNG the service itself writes.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use this package when an agent should see and drive the CAD workbench the user is looking at — inspect what model is loaded, select a part by name, frame a view, adjust display options, or capture the viewport — without desktop screenshots or hand-written requests against the service API. It pairs naturally with [`@deepseek-ai/dsh-castudio-context`](../castudio-context/README.md), which tells the model which workbenches are open.

### When to choose it

Choose it for agent workflows that must observe or operate the live CAStudio viewport. Avoid it when no CAStudio service is running or when the work is purely file-level parametric editing — the per-project HTTP API documented in each workspace's `AGENTS.md` remains the right surface for that. The tool needs a workbench page actually open in a browser; with none connected it tells the model to ask the user to open the CAD workbench tab.

### Minimal configuration

Every field is optional; the plugin resolves the service origin from `url`, then `COSERVE_CASTUDIO_URL`, then `http://127.0.0.1:4317`.

```yaml
- name: '@deepseek-ai/dsh-tool-castudio'
  config:
    url: http://127.0.0.1:4317
    stateTimeoutMs: 3000
    commandTimeoutMs: 12000
```

| Field | Default | Meaning |
|---|---|---|
| `url` | env `COSERVE_CASTUDIO_URL`, then `http://127.0.0.1:4317` | CAStudio service origin; only http(s) origins load |
| `stateTimeoutMs` | `3000` | Timeout for the workbench list and per-project state reads |
| `commandTimeoutMs` | `12000` | Timeout for one viewport command; above the service's own 10-second answer window |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-castudio) is the exhaustive source for the accepted fields.

### What each call does

One tool, `cad_workbench`, with an `action` discriminator:

- `state` reads the workbench's live viewport state: workspace tab, model file or demonstration geometry with load status, up to 200 parts with id/name/visibility, selection, display options, and camera.
- `snapshot` asks the service to render the viewport to a PNG under the project's `artifacts/viewport/` directory (the service keeps the newest 10) and returns its paths, dimensions, and byte count; the rendered result tells the model to open the absolute path with `read_image`.
- `fit` frames the model from `iso`, `top`, `front`, or `right`.
- `select` picks a part by id or exact name; `select_face` picks one CAD face on a part; `visible` shows or hides a part.
- `options` merges any subset of `edges`, `grid`, `ortho`, `section` (0–100), `explode` (0–180), and `mode` (`component`/`face`).
- `workspace` switches the `model`, `parametric`, `structural`, or `thermal` tab.
- `open` opens the model file `path`, relative to the target part's workspace, in the viewer; with `partSlug` it first switches the viewer to that part.
- `panel` expands or collapses the `viewer`, `editor`, `files`, or `properties` panel.

When several workbenches are connected the call must name one through `project`; with exactly one connected it is the default, and with none the call fails with instructions to ask the user to open the CAD workbench tab. The `part` argument is a mesh (viewport object) id or exact name, resolved against the freshly reported mesh list: an exact id wins, then an exact name; ambiguous or unknown names fail with the candidate list.

A CAD project holds parts: part `default` is the workspace root and every other part lives in `parts/<slug>/`. Every action accepts an optional `partSlug`, sent as the command's `part`: on `open` it is the part to switch to, on every other command it is the part the caller expects the viewer to show, and the service refuses the command with HTTP 409 when the viewer shows another part. `state` reads whatever part is shown. Every result names the part the viewer shows, taken from the returned state (`default` when the page reports none).

### Errors the model sees

Service unreachable, non-OK listings, malformed payloads, an unresponsive workbench, rejected commands (the service's own error text is surfaced), ambiguous mesh names, and missing cross-field arguments all fail the call with a `cad_workbench:`-prefixed message so the model can correct its next attempt. A 409 on a command that named `partSlug` additionally tells the model to call `open` with that `partSlug` or read the shown part with `state`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the tool and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **One aggregate read, then one command.** Project discovery always goes through `GET /api/dsh/viewports` — a single request that already filters to connected workbenches — so the tool never probes every project. Mesh-targeting actions fetch the per-project state once for part-name resolution, then dispatch exactly one whitelist command.
- **The service owns the effects.** Selection, camera, visibility, options, workspace, and the snapshot PNG are all applied by the open page through the CAStudio viewport bridge; the tool only maps arguments onto the documented command shapes and never writes project files itself.
- **Wire helpers are shared, not duplicated.** Origin resolution (`resolveCAStudioOrigin`), the timeout+abort fetch (`caStudioFetch`), and the viewport payload parsers live in [`@deepseek-ai/dsh-castudio-context`](../castudio-context/README.md) so context injection and this tool can never disagree about the service contract.
- **Fail visibly, degrade never silently.** Every transport or shape failure throws a `cad_workbench:`-prefixed error; only caller cancellation propagates untouched.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, tool registration, workbench/part resolution, command mapping, canonical output and presenters |

### Export shape

The plugin is a function/namespace plugin: it exports `name` / `inject` / `Config` / `apply` and no default export. A stray `export default` would make the Loader's `unwrapExports` collapse the module and drop `inject` (see [postmortem 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)).

### Call mechanics

`execute` validates the per-action field set by hand (the parameter root is an open object, so schema alone cannot reject fields belonging to other actions), lists connected workbenches, resolves the target project, resolves `part` to a mesh id against a fresh state read when the action needs one, POSTs the mapped `ViewportCommand` with `partSlug` as its `part`, and returns a bounded canonical value: project identity, the part the viewer shows, echoed action, the projected viewport state (parts capped at 200 rows plus totals), and the snapshot block when present.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the sibling context package to the generated catalogs and the service-side bridge.

- [`@deepseek-ai/dsh-castudio-context`](../castudio-context/README.md) — the per-step context that names the open workbenches and exports the shared wire helpers.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-castudio) — the `cad_workbench` schema the model receives.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-castudio) — every accepted config field and its source declaration.
- CAStudio service README — the viewport bridge endpoints, command whitelist, staleness rule, and snapshot retention this tool calls.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`cad_workbench` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-castudio): a required `action` enum (`state`, `snapshot`, `fit`, `select`, `select_face`, `visible`, `options`, `workspace`, `open`, `panel`) plus optional `project`, `partSlug`, `view`, `path`, `panel`, `state`, `part` (a mesh name or id), `face`, `visible`, `options`, and `workspace` fields with per-action descriptions. The description states the workbench-inspection purpose, the part layout (`default` is the workspace root, others live in `parts/<slug>/`), the `partSlug` rule, and the `project` selection rule.

#### Token effect

Fixed schema cost on every request where the tool is visible; the description and schema are stable for a given origin.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged. Plugin lifecycle or scoped restrictions may invalidate reuse from this schema.

### Tool-call history and result

#### What the model sees

Each call renders one text result headed `CAD workbench "<name>" (id <id>), part "<part name>" (<slug>)`. `state` returns the tab, model subject and load status, mesh totals with a 200-row listing cap, selection, display options, and camera; command actions return `… applied.` plus the same state block when the service reports one; `snapshot` returns the absolute PNG path, dimensions, byte count, and an instruction to open it with `read_image`. Failures render as `Error: cad_workbench: …` with correction guidance (open the workbench tab, pass `project`, use a part id).

#### Token effect

Results are bounded: at most 200 part rows plus fixed fields per call, and snapshot results are a few lines. Arguments stay in history until compaction like any tool call.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the tool is a poor fit. They are current package constraints, not a task backlog.

- **A live workbench page is required** — state lives only in the browser viewport; with no connected page every action fails with instructions to ask the user to open the CAD workbench tab. State is memory-only on the service and is lost on service restart until the page reports again.
- **Commands are view-state only** — the whitelist cannot edit geometry, run builds, or touch project files; the per-project HTTP API remains the surface for parametric work.
- **Part resolution is exact** — ids or exact names only; substring or fuzzy matching is deliberately absent so ambiguous CAD names fail loudly instead of picking wrong.
- **Single command in flight per call** — each invocation issues its requests sequentially and the tool declares no concurrency safety, so overlapping `cad_workbench` calls are not parallelized by the executor.
- **No image attachment** — `snapshot` returns a path the model must open through `read_image`; the tool does not inline image content.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: richer workbench actions

The command whitelist mirrors the CAStudio viewport bridge exactly. New bridge actions (measurements, review locations, section presets) would extend `Action`, `ACTION_FIELDS`, and `buildCommand` without changing the output contract.

</details>
