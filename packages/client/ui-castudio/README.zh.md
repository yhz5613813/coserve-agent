---
description: "在 DSH 原生对话旁提供 CAD 项目工作区、几何引用和内嵌工程工具。"
kind: "package-reference"
---

# DSH 原生对话中的 CAD 工作区

[English](README.md) | 中文

## 概述

在 DSH 原生对话旁打开 CAD 项目、附加几何引用，并启动关闭视图后仍继续运行的热优化。DSH 管理模型访问和工具权限；CAStudio 检查设计并执行仿真。此功能需要桌面桥接及运行中的 CAStudio 服务。

## 目录

- [工作区行为](#workspace-behavior)
- [仿真驱动 CAD 自动优化](#simulation-driven-cad-optimization)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="workspace-behavior"></a>
## 工作区行为

桌面端打开 DSH 原有对话，并在右侧栏提供 CAD 标签。没有独立的 CAStudio 对话或顶层侧栏入口。CAD 项目的 Session 仅在其右侧栏没有显示任何标签时自动打开该标签；用户选中的标签，或保留标签后收起的右侧栏，均保持不变。DSH 通过现有 harness 管理模型凭据、请求、工具执行、审批、取消和历史。本包使用公开的 UI 与宿主扩展服务，不修改 agent loop（智能体循环）。

选择 CAD 项目会准备其现有文件系统目录，将其注册为 DSH 原生 Workspace，并打开原生 Session。服务保留项目说明，在 `.agents/skills` 中安装随包提供的 CAD、参数化和仿真技能。项目文件仍保存在 CAD 服务使用的同一目录中。

内嵌工作区使用 `embedded=1&harness=dsh`，并附加框架加载时取得的 `client`（Session id）、`theme`（`light` 或 `dark`）和 `locale`（当前 DSH 语言 id）；之后的主题变化通过 `castudio:theme` 消息送达，不重新加载框架。框架还会收到 `castudio:busy`，表示该 Session 的智能体轮次是否正在运行，在每次变化时以及框架报告 `castudio:ready` 后发送。CAD、文件、编辑器、构建和仿真界面保持可用；不使用旧版 Pi 对话和模型设置。文件刷新不会重新挂载编辑器。原有 Pi 对话记录保留在磁盘上，不转换为 DSH 原生历史。

视口选择变成原生文件样式的引用标签，显示部件名称和可选的面标识。重复点选同一目标不会增加重复标签。支持原生编辑、删除、撤销和草稿持久化；提交时将保留的引用及其几何上下文序列化。已发送消息也显示紧凑引用。显式分析反馈仍以普通草稿文字插入。只接受来自当前 iframe 窗口、其来源和当前项目的消息。工作台使用 DSH 解析后的主题 token、字体和控件圆角；主题更新保留正在运行的编辑器。此包依赖桌面桥接，不启动额外服务器。

从文件树或对话链接打开 `.step`、`.stp`、`.stl`、`.glb`、`.gltf`、`.obj`、`.CATPart` 或 `.CATProduct` 文件时，文件显示在 CAD 工作台中。此包为这些扩展名单独注册一个 `cad-viewer` 标签类型；它的 `canOpen` 只接受位于 CAD 项目内的会话的文件，其余会话保持普通预览。该标签不承载内容：它记录一条带序号的打开请求，在原位置切换到 CAD 标签并关闭自身，重新加载后恢复出的该标签只会关闭。随后 CAD 框架收到 `{ type: 'castudio:open', projectId, path, part? }`：`path` 相对于部件工作区，`part` 是开头 `parts/<slug>/` 文件夹的 slug（默认部件不带该字段）。框架在报告 `castudio:ready` 之前收到的请求，会在此时发送一次。

CAD 项目中的空白 Session 会在输入框上方显示紧凑的「是否继承已有零件？」卡片，首页输入框和对话中的输入框均会显示；继承零件后，对话在该零件的文件夹中工作。零件只在 CAD 工作台中创建，卡片不提供创建入口。卡片列出 `GET /api/projects/:rootId/parts` 返回的零件，推荐零件排在最前，每个零件占一行，显示名称、状态（已发布、已做结构分析或已做热分析，取决于该行是否带有同名字段）和距上次改动的时间。列表较长时可滚动。项目没有零件，或只有根零件、该零件未发布且该工作区没有其他非空白 Session 时，卡片不显示，对话不带零件开始。卡片预选一个零件并标注「推荐」。评分规则：项目中最近上报的 CAD 工作台（`GET /api/dsh/viewports`）正在显示的零件得 2 分；该项目最近更新的非空白 Session 处理过的零件得 2 分（较早的 Session 得 1 分）；`updatedAt` 最新的零件得 1 分。得分最高者胜出；同分时取更近更新的零件，再取列表中靠前的零件。「继承所选零件」在草稿开头插入文件夹样式的零件标签，打开 CAD 标签，并发送带零件 slug（根零件为 `default`）的 `castudio:open`；零件有模型文件时，以第一个模型文件作为 `path` 一并发送。「不继承」为该 Session 隐藏卡片。草稿中出现零件标签或 Session 收到第一条消息后，卡片消失。

宿主端在 `sessionProjections` 存在时注册 `cadPart` Session projection。其值为最近一条带有效 `<cad-part>` 标记的人类 `user/message` 给出的 `{ projectId, slug, name }`，出现标记之前为 `null`；不带标记的消息不改变该值。该值属于 Session 摘要。侧栏的 Session 行以紧凑的尾部徽标（`sidebar.session.row.trailing`）显示零件名称。本包还注册 `castudio.part` Session 分组提供者，使每个工作区按零件对 Session 分组，未指定零件的 Session 排在最后。推荐规则读取同一摘要值。

<a id="simulation-driven-cad-optimization"></a>
## 仿真驱动 CAD 自动优化

热仿真结果页可创建持久化 CAStudio 优化任务。宿主独立于工作台视图轮询本地队列，为优化工作区创建专用 Session，通过 DSH 后台任务和已配置模型的 `spawn` 子代理生成每轮设计。设计子代理只允许调用 `structured_output`；CAStudio 独立构建、检查、重绑边界、求解与评分。模型回答结束仅表示本轮提案完成，不表示优化任务结束。任务服务统一管理版本、领取令牌、尝试预算、冻结工况、排名、取消和恢复。

宿主配置提供 `optimizationEnabled`、`url`、`pollIntervalMs`、`requestTimeoutMs`、`proposalTimeoutMs`、`agentPreset` 和 `proposalReasoningEffort`。每次提案默认最多6分钟，推理强度默认 `low`，保留父会话的模型与服务商；强度设为空字符串则继承父会话设置。此限制用于避免最高推理强度消耗整个优化时间预算。任务停止或过期会取消实际子代理；提交响应丢失时用相同尝试编号与令牌重试，过期提案由服务拒绝。关闭 CAD 面板不影响运行。关闭桌面会结束模型任务，CAStudio 识别宿主失联后要求明确恢复。原有“将结果加入设计对话”仍只添加草稿。

<a id="model-experience"></a>
## 模型体验

### 用户提示

#### 模型看到的内容

DSH 通过正常工作区发现机制读取项目 AGENTS.md 并发现工程技能。CAD 引用序列化为 `<cad-selection>` 块，在普通用户消息日志中包含所选项目、零件 slug、文件、部件和几何信息。零件 slug 取自用户选取时 iframe 发来的选择，并固定在引用中，因此视口切换到其他零件后，已提交或已恢复的消息仍指向原零件；没有零件的选择（早于零件功能的页面）不携带该字段。选定的零件在第一条用户消息开头序列化为 `<cad-part>{"projectId","part","name","folder"}</cad-part>`，其中根零件的 `folder` 为 `./`，其他零件为 `parts/<slug>/`；已发送消息将其显示为零件标签。被删除的标签不贡献上下文。CAD 工具和 HTTP 服务通过现有原生文件系统与 shell 工具调用。不会将提示发送到 CAStudio 旧版 `/prompt` 端点。

#### Token 开销

保留的几何引用和零件标签会增加当前用户消息的文字量；移除引用后不再附加该上下文。优化提案还包含固定约束和当前任务的计算历史。

#### KV Cache 影响

引用和优化历史作为普通消息内容提交，不改写既有消息。具体缓存命中由模型服务商决定；每轮变化的内容不能视为可复用前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 历史 Pi 对话保留为独立文件。现有独立 CAStudio 运行方式保持可用。非中文语言使用英文 CAD 字典。
- Session 列表不支持按零件筛选；其搜索只匹配标题、工作区和 Session id。

### 开发备注

<details>
<summary>维护者工作上下文</summary>

宿主控制器位于 `src/optimization-driver.ts`；CAStudio 在仓库根目录的 `castudio/server/optimization.ts` 中管理任务状态。录制的提案测试使用经过筛选的模型输出，不会调用模型服务商。

</details>
