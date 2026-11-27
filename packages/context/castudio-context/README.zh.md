---
description: "可选的按轮次 CAStudio CAD 服务上下文，供启用或调优 agent（智能体）对已打开 CAD 项目感知的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-castudio-context

[English](README.md) | 中文

## 概述

`dsh-castudio-context` 让模型了解本地 CAStudio CAD 服务正在运行、以及它管理哪些 CAD 项目，而不受会话自身 workspace 的限制。它仅在项目集合、已连接工作台摘要或参数化运行时状态发生变化时，于每轮的第一个步骤追加一条持久、带来源的读数。服务不可达、响应非 OK 或负载格式错误时不添加任何内容，也不会使该轮失败。随附的 Web preset 会挂载此插件；headless 与 minimal 组合不挂载。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当 agent 应了解位于其 workspace 之外的 CAStudio CAD 工作时挂载此插件——例如桌面会话在默认 workspace 中聊天，而 CAStudio 标签页里开着一个 CAD 项目。每条读数都是持久历史中额外的一条 user 角色消息；项目集合未变化时不添加任何内容，因此长时会话累积很少。

### 模型能得到什么

在 CAStudio 状态发生变化的每一轮，模型会收到一条带来源标记的上下文消息，列出服务来源、每个受管项目的名称、id、workspace 路径与绝对 castudio skill 指南路径（上限为 `maxProjects`）、`/api/projects/<id>` 下供参数化编辑、构建、测量与仿真使用的逐项目 HTTP API 模式、一行参数化 CAD 环境是否已配置的状态，以及用户当前打开的每个 CAD 工作台的稳定摘要。读数只发生在每轮的第一个步骤；轮次中途新增、重命名或删除的项目会在下一轮反映。

### 配置

最小挂载无需任何配置：服务来源依次取 `url`、`COSERVE_CASTUDIO_URL` 环境变量（桌面壳读取的同一变量）、`http://127.0.0.1:4317`。

```yaml
- name: '@deepseek-ai/dsh-castudio-context'
  config:
    url: http://127.0.0.1:4317
    timeoutMs: 2000
    refreshIntervalMs: 60000
    maxProjects: 20
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `url` | `COSERVE_CASTUDIO_URL`，然后是 `http://127.0.0.1:4317` | CAStudio 服务来源；仅接受 http(s) 来源 |
| `timeoutMs` | `2000` | 每次请求的超时毫秒数 |
| `refreshIntervalMs` | `0`（每个变化的轮次） | 一个会话内两次持久注入之间的最小毫秒数 |
| `maxProjects` | `20` | 每条读数列出的最大项目数；超出部分折叠为计数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-castudio-context)是每个可接受字段及其 JSDoc 的穷尽来源。

### 何时认定服务可用

探测是每个合格轮次一次 `GET /api/dsh/projects`、`GET /api/dsh/viewports` 与 `GET /api/parametric/runtime`。连接失败是"服务未运行"的预期情形，保持静默；成功但格式错误的响应会记录警告。项目列表探测失败会抑制整条读数；工作台与参数化运行时探测是附加的，失败时仅省略各自小节。无论哪种情况，该轮都在没有读数或部分读数的情况下继续，不会失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

本节解释插件的设计；可观察行为见[使用本包](#use-this-package)。

### 设计概念

插件前置一个 `agent/pre-step` 监听器，仅在每轮第一个步骤运行。到期时，它通过纯 HTTP 获取项目列表——无子进程、无 shell——校验网络负载，按 id 排序项目以获得稳定渲染，并将渲染状态与最近一次持久注入比较。时间戳与服务的最近活动排序被有意排除在比较状态之外，因此常规的项目触碰永远不会触发重新注入。

### 源码映射

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：首步监听器、HTTP 探测、变化抑制、调度 |

### 主要流程

pre-step 监听器在等待投影注册完成之前安装。激活期间到达的步骤会等待读取器；注册失败或属主销毁会阻止请求继续，等待期间的取消不会执行任何获取或上下文注入。

在每轮第一个步骤，监听器检查注入是否到期，查询服务，并将渲染状态与此来源最近一次持久注入比较。变化抑制与间隔调度扫描原始持久会话事件，因此调度在压缩与进程恢复后依然成立，无需进程本地缓存状态；各会话独立调度。下游 pre-step 监听器的拒绝或失败会阻止读数被记录。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从同类上下文插件到穷尽配置逐步深入。

- [tmux 位置上下文](../tmux-context/README.zh.md)——本包所镜像的同级按轮环境读数。
- [时间上下文](../time-context/README.zh.md)——另一个可选的请求准备上下文。
- [上下文组地图](../README.zh.md)——同级请求上下文包。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-castudio-context)——每个可接受的配置字段及其源码声明。

-----

<a id="model-experience"></a>
## 模型体验

### 请求准备时的 CAStudio 上下文

#### 模型看到什么

在 CAStudio 状态发生变化的每一轮，一条带来源标记的上下文消息，包含下方标题与正文。`<project-list>` 是每个项目一行 `- "<name>" — id <id>, workspace <path>; CAD skill guide: <path>/.agents/skills/castudio/SKILL.md`，按 id 排序并以 `maxProjects` 为上限。`<path>` 含反斜杠且不含正斜杠时，指南路径使用反斜杠，否则使用正斜杠。`<workbench-list>` 仅在至少一个工作台视口已连接时出现；每个条目包含一行 `Project / Part: "<project>" / "<part name>" (<slug>) — part files are in <location>; model paths are relative to it`，其中 `<location>` 对 `default` 零件（页面未报告零件时同样按此处理）为 workspace 根目录，否则为 `parts/<slug>/ under the workspace root`；以及一行 `Meshes: <n> total`，统计视口中的网格数量。切换零件会改变稳定状态，并重新注入读数。

##### 变化轮次的读数

```markdown
CAStudio CAD service (turn <turn>):
A local CAStudio CAD service is running at <origin>. It manages these CAD projects:
<project-list>
Each project exposes a HTTP API at <origin>/api/projects/<id> for parametric editing, builds, measurements, and structural and thermal simulation; project files live in the workspace path. A prepared project workspace carries AGENTS.md and .agents/skills (castudio, cadflow, structural-sim, thermal-sim) documenting its API — read the castudio skill guide listed per project before CAD work. Use ordinary shell and file tools against the API; do not call the service's /prompt endpoint. The parametric CAD environment is configured, so geometry, colour and parameter edits through the parametric code API are available.

The user currently has these CAD workbenches open:
<workbench-list>
```

#### Token 影响

每条读数累积到被压缩遮蔽为止。项目集合、工作台摘要与参数化运行时状态均未变化——加上间隔抑制——时不添加任何内容；服务可达但零项目时仍会报告一次该事实。

#### KV Cache 影响

仅追加；新可见内容跟随可复用的请求前缀，不会使既有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定 CAStudio 上下文何时不合适。它们是当前包约束。

- **仅首步**——轮次中途创建或重命名的项目在下一轮反映，而非步骤之间。
- **项目集合，而非窗口状态**——服务没有"当前打开项目"端点，因此读数列出所有受管项目，而非 CAStudio 标签页选中的那一个。
- **不依赖 CAStudio**——本包与配置来源处应答的任意 HTTP 服务通信；除负载形状外不验证应答者确为 CAStudio。
- **静态指引**——API 用法段落是固定文本；逐项目的 skill 内容仍是各已准备 workspace 内的权威细节。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
