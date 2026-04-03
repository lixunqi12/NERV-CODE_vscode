<p align="center">
  <img src="https://img.shields.io/badge/NERV-CODE-cc1418?style=for-the-badge&labelColor=0A0A0C" alt="NERV CODE" />
  <img src="https://img.shields.io/badge/MAGI_SYSTEM-ONLINE-2D8B46?style=for-the-badge&labelColor=0A0A0C" alt="MAGI SYSTEM ONLINE" />
  <img src="https://img.shields.io/badge/version-序:1.0.0-D4494F?style=for-the-badge&labelColor=0A0A0C" alt="Version" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-green?style=flat-square" alt="Node" />
  <img src="https://img.shields.io/badge/bun-%3E%3D1.0-orange?style=flat-square" alt="Bun" />
  <img src="https://img.shields.io/badge/base-Claude_Code_v2.1.88-8C1C22?style=flat-square" alt="Base Version" />
</p>

```
 ███╗   ██╗███████╗██████╗ ██╗   ██╗     ██████╗ ██████╗ ██████╗ ███████╗
 ████╗  ██║██╔════╝██╔══██╗██║   ██║    ██╔════╝██╔═══██╗██╔══██╗██╔════╝
 ██╔██╗ ██║█████╗  ██████╔╝██║   ██║    ██║     ██║   ██║██║  ██║█████╗
 ██║╚██╗██║██╔══╝  ██╔══██╗╚██╗ ██╔╝    ██║     ██║   ██║██║  ██║██╔══╝
 ██║ ╚████║███████╗██║  ██║ ╚████╔╝     ╚██████╗╚██████╔╝██████╔╝███████╗
 ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝  ╚═══╝      ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝
```

<p align="center">
  <b>God's in his heaven. All's right with the world.</b>
</p>

<p align="center">
  <a href="./README.md">English</a>
</p>

---

## MAGI 系统启动

**NERV-CODE** 是一个以 NERV/MAGI 为主题的 Claude Code CLI (v2.1.88) 还原项目。通过公开 npm 包的 sourcemap 还原完整 TypeScript 源码，施加新世纪福音战士美学主题，可编译运行为完整功能的 AI 编程助手。

这是一个**研究与粉丝项目** — 所有功能来自原版 Claude Code，我们只添加了 NERV 涂装。

---

## 特别鸣谢

这个 GitHub 仓库副本以及 VS Code 扩展打包工作，均基于 **Ax1i1om** 的原始 **NERV-CODE** 项目。

- 原项目仓库：**[Ax1i1om/NERV-CODE](https://github.com/Ax1i1om/NERV-CODE)**

特别感谢原作者完成了项目本体、NERV 风格设计方向，以及让这次扩展封装成为可能的还原工作。

---

## 致谢 (REFERENCE)

> 遵循开源社区礼仪，我们衷心感谢以下项目：

### 上游项目

本项目站在巨人的肩膀上：

- **[zxdxjtu/claude-code-sourcemap](https://github.com/zxdxjtu/claude-code-sourcemap/tree/main)** — 原始 sourcemap 提取与源码还原方法论
- **[ChinaSiro/claude-code-sourcemap](https://github.com/ChinaSiro/claude-code-sourcemap)** — 构建系统、文档和社区贡献

### 声明

- **Claude Code** 源码版权归 [Anthropic, PBC](https://www.anthropic.com) 所有。本项目基于公开 npm 包还原，**仅供研究和学习使用**，不可商用。
- **新世纪福音战士** (Neon Genesis Evangelion) 由庵野秀明 / GAINAX / khara, Inc. 创作。本项目中所有 NERV/MAGI/EVA 相关内容均为**粉丝致敬，仅供娱乐**，与版权方无任何关联或授权关系。

---

## 第壱話：快速开始 — 使徒来袭

### 前置要求

- **Node.js** >= 18
- **Bun** >= 1.0（仅构建时需要）
- **Anthropic API Key**（用于实际对话）

### 一键安装

```bash
bash install.sh
```

脚本会自动完成依赖安装、内部 SDK 恢复、编译构建，并创建 `nerv` 命令到 `~/.local/bin/`。

### 手动编译

```bash
# 1. 安装依赖
npm install --legacy-peer-deps

# 2. 恢复 Anthropic 内部 SDK（从 sourcemap 还原的 node_modules）
cp -r node_modules_sourcemap/@anthropic-ai/bedrock-sdk node_modules/@anthropic-ai/
cp -r node_modules_sourcemap/@anthropic-ai/vertex-sdk node_modules/@anthropic-ai/
cp -r node_modules_sourcemap/@anthropic-ai/foundry-sdk node_modules/@anthropic-ai/

# 3. 构建
bun run build.ts
```

### 运行

```bash
# 查看版本
node dist/cli.js --version    # → 2.1.88 (NERV CODE)

# 查看帮助
node dist/cli.js --help

# 交互模式（必须在真实终端中运行）
node dist/cli.js

# 管道模式（需要 API Key）
ANTHROPIC_API_KEY=sk-ant-xxx node dist/cli.js -p 'hello'
```

> **注意**：交互模式必须在真实终端（Terminal.app / iTerm2）中运行。IDE 集成终端可能因 TTY 检测问题无法正常工作。可设置 `CLAUDE_CODE_FORCE_INTERACTIVE=1` 强制交互模式。

---

## 第弐話：架构 — MAGI 系统构成

```
┌─────────────────────────────────────────────────────────┐
│                    NERV CODE CLI                         │
│              src/entrypoints/cli.tsx                     │
├─────────────────────────────────────────────────────────┤
│  MELCHIOR-1          BALTHASAR-2         CASPER-3       │
│  ┌─────────────┐    ┌──────────────┐   ┌────────────┐  │
│  │   对话引擎   │    │    工具系统   │   │   服务层   │  │
│  │             │    │  (45 个工具)  │   │            │  │
│  │ query.ts    │◄──►│ BashTool     │   │  API 客户端│  │
│  │ QueryEngine │    │ FileEdit     │   │  MCP 协议  │  │
│  │             │    │ AgentTool    │   │  上下文压缩 │  │
│  │             │    │ MCPTool      │   │  Hooks     │  │
│  │             │    │ ...          │   │  Auth      │  │
│  └─────────────┘    └──────────────┘   └────────────┘  │
├─────────────────────────────────────────────────────────┤
│                   Terminal Dogma                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ REPL 界面   │  │ 权限系统     │  │ 设置层级      │  │
│  │ (React/Ink) │  │ (6 种模式)   │  │ (5 级继承)    │  │
│  └─────────────┘  └──────────────┘  └───────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 核心模块

| 模块 | 路径 | 职责 |
|------|------|------|
| 启动器 | `src/main.tsx` | CLI 初始化、命令路由 |
| 对话引擎 | `src/query.ts` + `src/QueryEngine.ts` | 有状态异步生成器、SSE 流式传输 |
| 工具 | `src/tools/` (45 个) | BashTool, FileEdit, AgentTool, MCPTool 等 |
| 命令 | `src/commands/` (80+ 个) | commit, review, config 等 CLI 命令 |
| 组件 | `src/components/` | React (Ink) 终端 UI 组件 |
| 服务 | `src/services/` | API 客户端、MCP、上下文压缩 |
| 常量 | `src/constants/` | NERV 主题提示词和 spinner 动词 |

### 多 Agent 系统

| 类型 | 隔离级别 | EVA 类比 |
|------|----------|----------|
| **SubAgent** | 完全上下文隔离 | 独立 Entry Plug |
| **Fork** | 共享 prompt 缓存 | Dummy Plug 系统 |
| **Teammate** | 独立进程，文件邮箱 | 多机协同出击 |

---

## 第参話：NERV 主题 — 改造内容

所有修改均为**纯外观变更** — 不改变 Claude 的任何行为。

### 配色系统 (`nerv-dark` 主题)

| Token | 色值 | 用途 |
|-------|------|------|
| `nerv-red` | `#B7282E` | 主品牌色、logo、重点 |
| `nerv-red-light` | `#D4494F` | 悬停状态、光效 |
| `terminal-black` | `#0A0A0C` | 主背景 |
| `eva-purple` | `#6B3FA0` | Agent 色 (初号机) |
| `eva-orange` | `#E87D2A` | Agent 色 (零号机) |

### 六角形图标

所有菱形图标 (`◇`/`◆`) 替换为六角形 (`⬡`/`⬢`)，致敬 AT 力场几何学与 MAGI 六角形显示面板。

### MAGI Spinner 动词 (60+)

```
MAGI Analyzing...        Pattern Blue Scanning...     AT Field Calculating...
CASPER Processing...      BALTHASAR Evaluating...      MELCHIOR Reasoning...
Terminal Dogma Accessing... Entry Plug Connecting...   S2 Engine Initializing...
Dead Sea Scrolls Parsing... SEELE Protocol Decrypting... Eva Cage Preparing...
```

### 欢迎界面

自定义 NERV 徽章与无花果叶剪影，以 NERV 红渲染。问候语：

> *God's in his heaven. All's right with the world.*

---

## 作戦計画：路线图 — Rebuild of NERV-CODE

| 阶段 | 版本 | 代号 | 状态 | 说明 |
|------|------|------|------|------|
| **序** | 1.0.0 | You Are (Not) Alone | **当前** | 首次开源发布。源码还原 + NERV 主题。 |
| **破** | 2.0.0 | You Can (Not) Advance | 计划中 | 扩展主题（错误界面、权限提示、生命周期消息）。插件系统。 |
| **Q** | 3.0.0 | You Can (Not) Redo | 计划中 | 大规模重构。MAGI 共识模式用于多 Agent 协调。 |
| **終** | 3.0+1.0 | Thrice Upon a Time | 计划中 | 功能完整。稳定发布。完全 NERV 整合。 |

---

## 项目结构

```
NERV-CODE/
├── src/                        # TypeScript 源码 (1,884 文件)
│   ├── entrypoints/cli.tsx     # CLI 入口
│   ├── main.tsx                # 启动器与命令路由
│   ├── tools/                  # 45 个工具实现
│   ├── commands/               # 80+ CLI 命令
│   ├── services/               # API、MCP、压缩等服务
│   ├── components/             # React (Ink) TUI 组件
│   ├── constants/              # NERV 主题提示词与动词
│   └── utils/                  # Git、模型、认证、设置
├── shims/                      # 构建时替代模块
├── docs/                       # 文档
├── .github/                    # Issue 与 PR 模板
├── build.ts                    # Bun 构建配置
├── install.sh                  # 一键安装脚本
├── package.json                # 依赖 (84+)
└── tsconfig.json               # TypeScript 配置
```

---

## 构建系统

使用 **Bun Bundler** 将 TypeScript 编译为单文件 ESM bundle，通过 4 个自定义插件解决兼容性问题：

| 插件 | 作用 |
|------|------|
| `bun-bundle-shim` | 将编译时 `feature()` 替换为运行时 `Set.has()` (78 个 feature flag) |
| `react-compiler-runtime` | 重定向 `react/compiler-runtime` 到 npm 包 |
| `native-stubs` | 将 8 个内部/原生包重定向到空 stub |
| `text-loader` | 将 `.md`/`.txt` 文件导入转为字符串 |

详见 [docs/BUILD.md](docs/BUILD.md)。

---

## 许可证

[MIT License](LICENSE)

**重要提示**：Claude Code 原始源码版权归 Anthropic, PBC 所有。EVA/NERV 相关内容为粉丝致敬 — 详见 [LICENSE](LICENSE)。

---

<p align="center">
  <b>NERV — God's in his heaven. All's right with the world.</b><br/>
  <sub>⬡ MELCHIOR-1: APPROVE ⬡ BALTHASAR-2: APPROVE ⬡ CASPER-3: APPROVE ⬡</sub>
</p>
