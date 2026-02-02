# LocalTopSH

Minimal ReAct agent with Telegram interface. ~1200 lines of code.

## Architecture

```
User (Telegram) → Bot → ReAct Agent → Tools → LLM
                         ↓
                   Think → Act → Observe → Repeat
```

## Tools (9)

| Tool | Description |
|------|-------------|
| `run_command` | Execute shell commands |
| `read_file` | Read file content |
| `write_file` | Create/overwrite file |
| `edit_file` | Edit file (find & replace) |
| `search_files` | Find files by glob pattern |
| `search_text` | Search text in files (grep) |
| `list_directory` | List directory contents |
| `search_web` | Web search (Z.AI + Tavily) |
| `fetch_page` | Fetch URL content |

## Quick Start

```bash
cp .env.example .env
# Edit .env with your tokens

docker compose up -d
```

## Configuration

```env
# LLM API (OpenAI-compatible)
BASE_URL=http://localhost:8000/v1
MODEL_NAME=openai/gpt-oss-20b
API_KEY=your-key

# Telegram
TELEGRAM_TOKEN=your-bot-token
ALLOWED_USERS=123456789

# Web Search (optional)
ZAI_API_KEY=your-zai-key
TAVILY_API_KEY=your-tavily-key
```

## Structure

```
src/
├── index.ts           # Entry point
├── agent/
│   ├── react.ts       # ReAct loop
│   └── system.txt     # System prompt
├── bot/
│   └── index.ts       # Telegram bot
├── gateway/
│   └── server.ts      # HTTP API (optional)
└── tools/
    ├── index.ts       # Tool registry
    ├── bash.ts        # run_command
    ├── files.ts       # File operations
    └── web.ts         # Web search
```

## Features

- ReAct loop with history summarization
- Telegram bot with HTML formatting
- Group support (mention/reply)
- User whitelist
- Full request/response logging
- Z.AI + Tavily web search

## License

MIT
