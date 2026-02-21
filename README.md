# BrowserClaw

Browser-native personal AI assistant. Zero infrastructure — the browser is the server.

Built as a browser-only reimagination of [NanoClaw](../README.md). Same philosophy — small enough to understand, secure by default, built for one user — but running entirely in a browser tab.

## Quick Start

```bash
cd browserclaw
npm install
npm run dev
```

Open `http://localhost:5173`, paste your [Anthropic API key](https://console.anthropic.com/), and start chatting.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Browser Tab (PWA)                                       │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────── │
│  │ Chat UI  │  │ Settings │  │ Task Manager           │ │
│  └────┬─────┘  └────┬─────┘  └──────┬─────────────── ┘ │
│       └──────────────┼───────────────┘                   │
│                      ▼                                   │
│              Orchestrator (main thread)                   │
│              ├── Message queue & routing                  │
│              ├── State machine (idle/thinking/responding) │
│              └── Task scheduler (cron)                    │
│                      │                                   │
│          ┌───────────┼───────────┐                       │
│          ▼           ▼           ▼                       │
│     IndexedDB      OPFS    Agent Worker                  │
│     (messages,   (group    (Claude API                   │
│      tasks,       files,    tool-use loop,               │
│      config)     memory)    WebVM sandbox)               │
│                                                          │
│  Channels:                                               │
│  ├── Browser Chat (built-in)                             │
│  └── Telegram Bot API (optional, pure HTTPS)             │
└──────────────────────────────────────────────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point, bootstraps UI |
| `src/orchestrator.ts` | State machine, message routing, agent invocation |
| `src/agent-worker.ts` | Web Worker: Claude API tool-use loop |
| `src/tools.ts` | Tool definitions (bash, read/write files, fetch, etc.) |
| `src/vm.ts` | WebVM wrapper (v86 Alpine Linux in WASM) |
| `src/db.ts` | IndexedDB: messages, sessions, tasks, config |
| `src/storage.ts` | OPFS: per-group file storage |
| `src/router.ts` | Routes messages to correct channel |
| `src/channels/browser-chat.ts` | In-browser chat channel |
| `src/channels/telegram.ts` | Telegram Bot API channel |
| `src/task-scheduler.ts` | Cron expression evaluation |
| `src/crypto.ts` | AES-256-GCM encryption for API keys |
| `src/ui/` | Chat, settings, and task manager components |

## How It Works

1. **You type a message** in the browser chat (or send one via Telegram)
2. **The orchestrator** checks the trigger pattern, saves to IndexedDB, queues for processing
3. **The agent worker** (a Web Worker) sends your message + conversation history to the Anthropic API
4. **Claude responds**, possibly using tools (bash, file I/O, fetch, JavaScript)
5. **Tool results** are fed back to Claude in a loop until it produces a final text response
6. **The response** is routed back to the originating channel (browser chat or Telegram)

## Tools

| Tool | What it does |
|------|-------------|
| `bash` | Execute shell commands in a sandboxed Linux VM (Alpine in WASM) |
| `javascript` | Execute JS code in an isolated scope (lighter than bash) |
| `read_file` / `write_file` / `list_files` | Manage files in OPFS per-group workspace |
| `fetch_url` | HTTP requests via browser `fetch()` (subject to CORS) |
| `update_memory` | Persist context to CLAUDE.md (loaded on every conversation) |
| `create_task` | Schedule recurring tasks with cron expressions |

## Telegram

Optional. Works entirely via HTTPS — no WebSockets or special protocols.

1. Create a bot with `@BotFather` on Telegram
2. Open Settings in BrowserClaw, paste the bot token
3. Send `/chatid` to your bot to get the chat ID
4. Add the chat ID in Settings
5. Messages from Telegram are processed the same as browser chat

**Caveat**: The browser tab must be open for the bot to respond. Messages queue on Telegram's side and are processed when you reopen the tab.

## WebVM (Optional)

The `bash` tool runs commands in a v86-emulated Alpine Linux. To enable:

1. Download the v86 WASM binary and Alpine rootfs image
2. Place them in `public/assets/`:
   - `public/assets/v86.wasm`
   - `public/assets/v86/libv86.js`
   - `public/assets/alpine-rootfs.ext2`
3. The VM boots automatically on first use (~5-15 seconds)

Without these assets, the `bash` tool returns a helpful error. All other tools work without the VM.

## Comparison with NanoClaw

| | NanoClaw | BrowserClaw |
|---|---|---|
| Runtime | Node.js process | Browser tab |
| Agent sandbox | Docker/Apple Container | Web Worker + WebVM |
| Database | SQLite (better-sqlite3) | IndexedDB |
| Files | Filesystem | OPFS |
| Primary channel | WhatsApp | In-browser chat |
| Other channels | Telegram, Discord | Telegram |
| Agent SDK | Claude Agent SDK | Raw Anthropic API |
| Background tasks | launchd service | setInterval (tab must be open) |
| Deployment | Self-hosted server | Static files (any CDN) |
| Dependencies | ~50 npm packages | 0 runtime deps |

## Development

```bash
npm run dev        # Vite dev server with HMR
npm run build      # Production build → dist/
npm run preview    # Preview production build
npm run typecheck  # TypeScript type checking
```

## Deploy

```bash
npm run build
# Upload dist/ to any static host:
# GitHub Pages, Cloudflare Pages, Netlify, Vercel, S3, etc.
```

No server needed. It's just HTML, CSS, and JS.
