---
description: "Opt-in per-turn CAStudio CAD service context for users and maintainers enabling or tuning the agent's awareness of open CAD projects."
kind: "package-reference"
---

# @deepseek-ai/dsh-castudio-context

English | [中文](README.zh.md)

## Summary

`dsh-castudio-context` lets the model learn that a local CAStudio CAD service is running and which CAD projects it manages, regardless of the session's own workspace. It adds a durable, source-attributed reading on the first step of a turn only when the project set, the connected-workbench summary, or the parametric-runtime status changed. An unreachable service, a non-OK response, or a malformed payload adds nothing and does not fail the turn. The shipped Web presets mount this plugin; headless and minimal compositions do not.

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

Mount this plugin when agents should know about CAStudio CAD work that lives outside their workspace — for example a desktop session chatting in the default workspace while a CAD project is open in the CAStudio tab. Each reading is one additional user-role message in durable history; an unchanged project set adds nothing, so long-running sessions accumulate little.

### What the model gets

On each turn whose CAStudio state changed, the model receives one source-tagged context message naming the service origin, every managed project's name, id, workspace path, and absolute castudio skill-guide path (bounded by `maxProjects`), the per-project HTTP API pattern under `/api/projects/<id>` that parametric editing, builds, measurements, and simulation use, one line reporting whether the parametric CAD environment is configured, and a stable summary of each CAD workbench the user currently has open. Readings happen on the first step of a turn only; a project added, renamed, or removed mid-turn is reflected on the next turn.

### Configuration

The minimal mount needs no configuration: the service origin comes from `url`, then the `COSERVE_CASTUDIO_URL` environment variable (the same variable the desktop shell reads), then `http://127.0.0.1:4317`.

```yaml
- name: '@deepseek-ai/dsh-castudio-context'
  config:
    url: http://127.0.0.1:4317
    timeoutMs: 2000
    refreshIntervalMs: 60000
    maxProjects: 20
```

| Field | Default | Meaning |
|---|---|---|
| `url` | `COSERVE_CASTUDIO_URL`, then `http://127.0.0.1:4317` | CAStudio service origin; only http(s) origins load |
| `timeoutMs` | `2000` | Per-request timeout in milliseconds |
| `refreshIntervalMs` | `0` (every changed turn) | Minimum milliseconds between durable injections in one session |
| `maxProjects` | `20` | Maximum projects listed per reading; the rest collapse to a count |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-castudio-context) is the exhaustive source for every accepted field and its JSDoc.

### When the service is known

The probes are `GET /api/dsh/projects`, `GET /api/dsh/viewports`, and `GET /api/parametric/runtime` per eligible turn. A connection failure is the expected "service not running" case and stays silent; a successful but malformed response is logged as a warning. A failed projects probe suppresses the reading; the workbench and parametric-runtime probes are additive and degrade to omitting their sections. Either way the turn proceeds without failing.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the plugin; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

The plugin prepends an `agent/pre-step` listener that runs only on the first step of each turn. When due, it fetches the project list over plain HTTP — no subprocess, no shell — validates the wire payload, sorts projects by id for a stable rendering, and compares the rendered state with its latest durable injection. Timestamps and the service's recent-activity ordering are deliberately excluded from the compared state, so routine project touches never force a re-injection.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: first-step listener, HTTP probe, change suppression, scheduling |

### Main flow

The pre-step listener is installed before awaiting projection registration. Steps arriving during activation wait for the reader; registration failure or owner disposal stops the request, and cancellation while waiting performs no fetch or context injection.

At the first step of a turn, the listener checks whether an injection is due, queries the service, and compares the rendered state with the latest durable injection of this source. Change suppression and interval scheduling scan the raw durable session events, so the schedule survives compaction and resumed processes without process-local cache state; sessions schedule independently. A downstream pre-step listener that rejects or fails prevents the reading from being recorded.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the sibling context plugins to the exhaustive configuration.

- [tmux location context](../tmux-context/README.md) — the sibling per-turn environment reading this package mirrors.
- [time context](../time-context/README.md) — the other opt-in request-preparation context.
- [Context group map](../README.md) — sibling request-context packages.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-castudio-context) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Preparation-time CAStudio context

#### What the model sees

On each turn whose CAStudio state changed, one source-tagged context message with the header and body below. `<project-list>` is one `- "<name>" — id <id>, workspace <path>; CAD skill guide: <path>/.agents/skills/castudio/SKILL.md` line per project, sorted by id and capped at `maxProjects`. The guide path uses backslashes when `<path>` contains backslashes and no forward slash, and forward slashes otherwise. `<workbench-list>` appears only while at least one workbench viewport is connected; each entry carries a `Project / Part: "<project>" / "<part name>" (<slug>) — part files are in <location>; model paths are relative to it` line, where `<location>` is the workspace root for part `default` (also assumed when the page reports no part) and `parts/<slug>/ under the workspace root` otherwise, and a `Meshes: <n> total` line counting the viewport's meshes. A part switch changes the stable state and re-injects the reading.

##### Changed-turn reading

```markdown
CAStudio CAD service (turn <turn>):
A local CAStudio CAD service is running at <origin>. It manages these CAD projects:
<project-list>
Each project exposes a HTTP API at <origin>/api/projects/<id> for parametric editing, builds, measurements, and structural and thermal simulation; project files live in the workspace path. A prepared project workspace carries AGENTS.md and .agents/skills (castudio, cadflow, structural-sim, thermal-sim) documenting its API — read the castudio skill guide listed per project before CAD work. Use ordinary shell and file tools against the API; do not call the service's /prompt endpoint. The parametric CAD environment is configured, so geometry, colour and parameter edits through the parametric code API are available.

The user currently has these CAD workbenches open:
<workbench-list>
```

#### Token effect

Each reading accumulates until compaction shadows it. Unchanged project sets, workbench summaries, and parametric-runtime status — plus interval suppression — add nothing; a reachable service with zero projects still reports that fact once.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV Cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when CAStudio context is a poor fit. They are current package constraints.

- **First step only** — a project created or renamed mid-turn is reflected on the next turn, not between steps.
- **Project set, not window state** — the service exposes no "currently open project" endpoint, so the reading lists every managed project rather than the one the CAStudio tab has selected.
- **No CAStudio dependency** — the package talks to whatever HTTP service answers at the configured origin; it does not verify the responder is CAStudio beyond the payload shape.
- **Static guidance** — the API-usage paragraph is fixed text; per-project skill contents remain the authoritative detail inside each prepared workspace.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
