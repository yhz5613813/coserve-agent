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

桌面端打开 DSH 原有对话，并在右侧栏提供 CAD 标签。没有独立的 CAStudio 对话或顶层侧栏入口。DSH 通过现有 harness 管理模型凭据、请求、工具执行、审批、取消和历史。本包使用公开的 UI 与宿主扩展服务，不修改 agent loop（智能体循环）。

选择 CAD 项目会准备其现有文件系统目录，将其注册为 DSH 原生 Workspace，并打开原生 Session。服务保留项目说明，在 `.agents/skills` 中安装随包提供的 CAD、参数化和仿真技能。项目文件仍保存在 CAD 服务使用的同一目录中。

内嵌工作区使用 `embedded=1&harness=dsh`。CAD、文件、编辑器、构建和仿真界面保持可用；不使用旧版 Pi 对话和模型设置。文件刷新不会重新挂载编辑器。原有 Pi 对话记录保留在磁盘上，不转换为 DSH 原生历史。

视口选择变成原生文件样式的引用标签，显示部件名称和可选的面标识。重复点选同一目标不会增加重复标签。支持原生编辑、删除、撤销和草稿持久化；提交时将保留的引用及其几何上下文序列化。已发送消息也显示紧凑引用。显式分析反馈仍以普通草稿文字插入。只接受来自当前 iframe 窗口、其来源和当前项目的消息。工作台使用 DSH 解析后的主题 token、字体和控件圆角；主题更新保留正在运行的编辑器。此包依赖桌面桥接，不启动额外服务器。

<a id="simulation-driven-cad-optimization"></a>
## 仿真驱动 CAD 自动优化

热仿真结果页可创建持久化 CAStudio 优化任务。宿主独立于工作台视图轮询本地队列，为优化工作区创建专用 Session，通过 DSH 后台任务和已配置模型的 `spawn` 子代理生成每轮设计。设计子代理只允许调用 `structured_output`；CAStudio 独立构建、检查、重绑边界、求解与评分。模型回答结束仅表示本轮提案完成，不表示优化任务结束。任务服务统一管理版本、领取令牌、尝试预算、冻结工况、排名、取消和恢复。

宿主配置提供 `optimizationEnabled`、`url`、`pollIntervalMs`、`requestTimeoutMs`、`proposalTimeoutMs`、`agentPreset` 和 `proposalReasoningEffort`。每次提案默认最多6分钟，推理强度默认 `low`，保留父会话的模型与服务商；强度设为空字符串则继承父会话设置。此限制用于避免最高推理强度消耗整个优化时间预算。任务停止或过期会取消实际子代理；提交响应丢失时用相同尝试编号与令牌重试，过期提案由服务拒绝。关闭 CAD 面板不影响运行。关闭桌面会结束模型任务，CAStudio 识别宿主失联后要求明确恢复。原有“将结果加入设计对话”仍只添加草稿。

<a id="model-experience"></a>
## 模型体验

### 用户提示

#### 模型看到的内容

DSH 通过正常工作区发现机制读取项目 AGENTS.md 并发现工程技能。CAD 引用序列化为 `<cad-selection>` 块，在普通用户消息日志中包含所选项目、文件、部件和几何信息。被删除的标签不贡献上下文。CAD 工具和 HTTP 服务通过现有原生文件系统与 shell 工具调用。不会将提示发送到 CAStudio 旧版 `/prompt` 端点。

#### Token 开销

保留的几何引用会增加当前用户消息的文字量；移除引用后不再附加该上下文。优化提案还包含固定约束和当前任务的计算历史。

#### KV Cache 影响

引用和优化历史作为普通消息内容提交，不改写既有消息。具体缓存命中由模型服务商决定；每轮变化的内容不能视为可复用前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 历史 Pi 对话保留为独立文件。现有独立 CAStudio 运行方式保持可用。非中文语言使用英文 CAD 字典。

### 开发备注

<details>
<summary>维护者工作上下文</summary>

宿主控制器位于 `src/optimization-driver.ts`；CAStudio 在仓库根目录的 `castudio/server/optimization.ts` 中管理任务状态。录制的提案测试使用经过筛选的模型输出，不会调用模型服务商。

</details>
