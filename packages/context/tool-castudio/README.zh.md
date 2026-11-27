---
description: "面向模型的 cad_workbench 工具，用于 CAStudio 中实时 CAD 工作台：查看视口状态、选择零件、调整相机与显示、切换工作区并保存视口快照，供选择、配置或调试该工具的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-castudio

[English](README.md) | 中文

## 概述

`dsh-tool-castudio` 为 agent 提供 `cad_workbench` 工具，用于操作用户在 CAStudio 中打开的 CAD 工作台。该工具读取哪些工作台在线，查看三维视口状态（模型、零件、选择、显示选项、相机），框选模型视角，按 id 或精确名称选择零件与 CAD 面，切换零件显隐，修改显示选项与工作区标签，并保存一张真实的视口 PNG，供 agent 再用 `read_image` 查看。它只与回环 CAStudio 服务通信并修改视图状态；唯一可能产生的文件是服务自身写入的快照 PNG。

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

当 agent 需要查看并驱动用户正在查看的 CAD 工作台时使用本包——查看加载了哪个模型、按名称选择零件、调整视角、修改显示选项或截取视口——无需桌面截图，也无需手写请求服务 API。它与 [`@deepseek-ai/dsh-castudio-context`](../castudio-context/README.zh.md) 天然配套，后者会告知模型哪些工作台已打开。

### 何时选择

当 agent 工作流必须观察或操作实时 CAStudio 视口时选择它。没有 CAStudio 服务运行、或工作纯属文件级参数化编辑时不要选择——每个项目工作区 `AGENTS.md` 中记录的项目 HTTP API 仍是那类工作的正确接口。该工具需要工作台页面真实打开在浏览器中；没有任何连接时，它会提示模型请用户打开 CAD 工作台标签页。

### 最小配置

所有字段均可选；插件按 `url`、`COSERVE_CASTUDIO_URL`、然后 `http://127.0.0.1:4317` 的顺序解析服务来源。

```yaml
- name: '@deepseek-ai/dsh-tool-castudio'
  config:
    url: http://127.0.0.1:4317
    stateTimeoutMs: 3000
    commandTimeoutMs: 12000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `url` | 环境变量 `COSERVE_CASTUDIO_URL`，然后 `http://127.0.0.1:4317` | CAStudio 服务来源；仅接受 http(s) 来源 |
| `stateTimeoutMs` | `3000` | 工作台列表与逐项目状态读取的超时 |
| `commandTimeoutMs` | `12000` | 单次视口命令的超时；高于服务自身 10 秒的应答窗口 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-castudio)是已接受字段的完整来源。

### 每次调用做什么

一个工具 `cad_workbench`，带 `action` 判别字段：

- `state` 读取工作台的实时视口状态：工作区标签、模型文件或演示几何体及加载状态、最多 200 个零件（含 id/名称/可见性）、选择、显示选项和相机。
- `snapshot` 让服务把视口渲染为 PNG，写入项目 `artifacts/viewport/` 目录（服务仅保留最新 10 张），返回路径、尺寸与字节数；渲染结果会提示模型用 `read_image` 打开绝对路径。
- `fit` 从 `iso`、`top`、`front` 或 `right` 框选模型。
- `select` 按 id 或精确名称选择零件；`select_face` 选择零件上的一个 CAD 面；`visible` 显示或隐藏零件。
- `options` 合并任意子集的 `edges`、`grid`、`ortho`、`section`（0–100）、`explode`（0–180）与 `mode`（`component`/`face`）。
- `workspace` 切换 `model`、`parametric`、`structural` 或 `thermal` 标签。
- `open` 在视口中打开模型文件 `path`（相对目标零件的 workspace）；带 `partSlug` 时先把视口切换到该零件。
- `panel` 展开或折叠 `viewer`、`editor`、`files` 或 `properties` 面板。

多个工作台连接时必须通过 `project` 指定；恰好一个连接时默认为它；一个都没有时调用失败，并提示模型请用户打开 CAD 工作台标签页。`part` 参数是网格（视口对象）的 id 或精确名称，依据最新上报的网格列表解析：精确 id 优先，然后精确名称；歧义或未知名称会带候选列表报错。

一个 CAD 项目包含多个零件：零件 `default` 是 workspace 根目录，其余零件位于 `parts/<slug>/`。每个 action 都接受可选的 `partSlug`，并作为命令的 `part` 发送：`open` 时它是要切换到的零件，其他命令时它是调用方预期视口显示的零件，视口显示其他零件时服务以 HTTP 409 拒绝命令。`state` 读取当前显示的任何零件。每个结果都会指明视口显示的零件，取自返回状态（页面未上报时为 `default`）。

### 模型看到的错误

服务不可达、列表非 200、负载畸形、工作台无响应、命令被拒（透传服务自身的错误文本）、网格名歧义以及缺失的跨字段参数，都会以 `cad_workbench:` 前缀的消息使调用失败，模型可据此修正下一次尝试。命名了 `partSlug` 的命令遇到 409 时，还会提示模型用该 `partSlug` 调用 `open`，或用 `state` 读取当前显示的零件。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具背后的设计决策并指出实现它们的代码；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **一次聚合读取，随后一条命令。** 项目发现始终走 `GET /api/dsh/viewports`——该请求已过滤为已连接工作台——工具不会逐项目探测。需要网格的操作先取一次逐项目状态用于零件名解析，然后只派发一条白名单命令。
- **效果归服务所有。** 选择、相机、显隐、选项、工作区以及快照 PNG 全部由打开的页面通过 CAStudio 视口桥执行；工具只把参数映射为约定的命令结构，本身从不写项目文件。
- **线路助手共享而非复制。** 来源解析（`resolveCAStudioOrigin`）、带超时与中止的请求（`caStudioFetch`）以及视口负载解析器都位于 [`@deepseek-ai/dsh-castudio-context`](../castudio-context/README.zh.md)，上下文注入与本工具对服务契约的理解永不分歧。
- **失败显式呈现，绝不静默降级。** 任何传输或结构失败都抛出 `cad_workbench:` 前缀的错误；只有调用方取消会原样传播。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、工具注册、工作台/零件解析、命令映射、规范输出与展示器 |

### 导出形状

该插件是函数/命名空间插件：导出 `name` / `inject` / `Config` / `apply`，无默认导出。多余的 `export default` 会让 Loader 的 `unwrapExports` 折叠模块并丢弃 `inject`（见[复盘 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md)）。

### 调用机制

`execute` 手工校验每个 action 的字段集合（参数根是开放对象，仅靠 schema 无法拒绝属于其他 action 的字段），列出已连接工作台，解析目标项目，在需要时针对最新状态读取解析 `part` 为网格 id，POST 映射后的 `ViewportCommand`（`partSlug` 作为其 `part`），并返回有界的规范值：项目标识、视口显示的零件、回显的 action、投影后的视口状态（零件最多 200 行加总数）以及存在时的快照块。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够用时阅读以下页面。它们从同组上下文包出发，连接到生成的目录与服务端桥接。

- [`@deepseek-ai/dsh-castudio-context`](../castudio-context/README.zh.md)——逐步骤上下文，说明哪些工作台已打开，并导出共享的线路助手。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-castudio)——模型收到的 `cad_workbench` schema。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-castudio)——每个已接受配置字段及其来源声明。
- CAStudio 服务 README——本工具调用的视口桥端点、命令白名单、新鲜度规则与快照保留策略。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

模型看到生成的 [`cad_workbench` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-castudio)：必填的 `action` 枚举（`state`、`snapshot`、`fit`、`select`、`select_face`、`visible`、`options`、`workspace`、`open`、`panel`），以及可选的 `project`、`partSlug`、`view`、`path`、`panel`、`state`、`part`（网格名称或 id）、`face`、`visible`、`options`、`workspace` 字段，各自带按 action 的说明。描述会说明工作台查看用途、零件布局（`default` 是 workspace 根目录，其余位于 `parts/<slug>/`）、`partSlug` 规则与 `project` 的选择规则。

#### Token 影响

工具可见的每个请求都有固定的 schema 开销；描述与 schema 在给定来源下保持稳定。

#### KV Cache 影响

定义与可见性不变时前缀稳定。插件生命周期或作用域限制可能使该 schema 的复用失效。

### 工具调用历史与结果

#### 模型看到什么

每次调用渲染一条以 `CAD workbench "<名称>" (id <id>), part "<零件名称>" (<slug>)` 开头的文本结果。`state` 返回标签、模型主题与加载状态、网格总数（网格列表上限 200 行）、选择、显示选项和相机；命令类 action 在服务上报状态时返回 `… applied.` 加同一状态块；`snapshot` 返回 PNG 绝对路径、尺寸、字节数，并提示用 `read_image` 打开。失败渲染为 `Error: cad_workbench: …`，并附修正指引（打开工作台标签页、传 `project`、改用零件 id）。

#### Token 影响

结果有界：每次调用最多 200 行零件加固定字段，快照结果仅几行。参数与其他工具调用一样在压缩前保留在历史中。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不使既有 KV-cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了该工具不适用的场景。它们是当前包约束，不是任务积压。

- **需要实时工作台页面**——状态只存在于浏览器视口中；没有任何已连接页面时所有 action 都会失败并提示请用户打开 CAD 工作台标签页。状态在服务内存中，服务重启后需页面重新上报。
- **命令仅限视图状态**——白名单不能编辑几何体、运行构建或触碰项目文件；参数化工作仍应使用各项目 HTTP API。
- **零件解析仅支持精确匹配**——只接受 id 或精确名称；刻意不做子串或模糊匹配，让歧义的 CAD 名称显式失败而不是选错。
- **每次调用单命令串行**——每次调用按顺序发起其请求，且工具未声明并发安全，因此执行器不会并行化重叠的 `cad_workbench` 调用。
- **不内联图像**——`snapshot` 返回路径，模型须通过 `read_image` 打开；工具本身不内嵌图像内容。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：未定的开放问题与方向。它明确不具权威性——已交付的行为、限制与已接受的理由以上述各节、包代码及所链接的 Agent Note 为准。

#### 未来：更丰富的工作台操作

命令白名单与 CAStudio 视口桥完全对应。桥新增 action（测量、评审定位、剖切预设）只需扩展 `Action`、`ACTION_FIELDS` 与 `buildCommand`，无需改动输出契约。

</details>
