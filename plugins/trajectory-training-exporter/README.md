# @local/trajectory-training-exporter (轨迹训练数据导出器)

Export saved session trajectories in CoServe-Agent / DeepSeek Harness directly into trainable agent datasets (JSONL).

## Features

- **Conversation View Tab (`conversation.view`)**: Adds an inline **「导出训练数据」 (`Training export`)** tab right next to the **「对话」 (`Chat`)** and **「轨迹」 (`Trajectory`)** tabs.
- **Session Header & Context Menus**: Quick export button in `conversation.session.header.utilities`, session header `...` menu, and sidebar session row menu.
- **Slash Command**: `/train-export [openai_chat|sharegpt|agent_steps|raw_trajectory] [output.jsonl]`
- **Agent Tool**: `export_training_trajectory` (`action: "list" | "preview" | "export"`)
- **Supported Training Formats**:
  1. `openai_chat`: Standard `messages` + `tools` + `reasoning_content` / `<think>` SFT format (compatible with TRL, verl, Axolotl, Slime, Miles, vLLM).
  2. `sharegpt`: Multi-turn `conversations` (`human` / `function_call` / `observation` / `gpt`) + `system` + `tools` (compatible with LLaMA-Factory).
  3. `agent_steps`: Per-step unrolled decision records (`prompt_messages`, `tools`, `action`, `observations`, `usage`, `reward`, `done`) for RL / GRPO and Process Reward Modeling (PRM).
  4. `raw_trajectory`: Complete structured turn/step trajectory with token and error statistics.
