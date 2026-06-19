# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Context

This is the **WhatsApp adapter** (`pathfinder-whatsapp`) for a Pathfinder 2e TTRPG group's lore wiki. It listens to a WhatsApp group and forwards `!wiki`-triggered or @mention queries to the **Query-Service** (`pathfinder-chat`, runs separately on the server), then sends the response back to the group.

The architecture is deliberately thin: this bot holds **no Anthropic API key** and contains no retrieval logic. It is purely a transport layer between WhatsApp and the Query-Service at `QUERY_SERVICE_URL/api/chat`.

Sister services on the DigitalOcean droplet (`ubuntu-s-foundry`):
- **Query-Service** → `/opt/pnp-wiki/query-service/` (Hono HTTP server, Tool-Use-based retrieval, Claude via `@anthropic-ai/sdk`)
- **Lore wiki** → `/opt/pnp-wiki/repo/wiki/*.md` (read-only volume mounted into the Query-Service container)

## Commands

```bash
npm install        # install dependencies
npm run start      # production start (tsx src/index.ts)
npm run dev        # watch mode with auto-restart
```

Docker (on server, from `/opt/pnp-wiki/whatsapp-bot/`):
```bash
docker-compose up -d --build   # build & start
docker-compose logs -f         # tail logs
docker-compose down            # stop
```

First start: the QR code prints to stdout — scan it with the WhatsApp prepaid number to authenticate. Auth state persists in `auth/` (gitignored).

## Architecture

All logic lives in `src/index.ts`. There are no other source files.

**Message handling flow:**
1. Baileys receives `messages.upsert` events.
2. Filter: only `type === 'notify'`, only group messages (`@g.us`), optionally only the configured `GROUP_JID`.
3. Trigger detection: `!wiki <question>` (prefix) **or** @mention of the bot (by phone number or LID — newer WhatsApp versions use LIDs instead of phone numbers in mention lists).
4. `queryWiki()` calls `POST QUERY_SERVICE_URL/api/chat` with `{ question }`, returns `{ text, sources[] }`.
5. `mdToWhatsApp()` converts Markdown to WhatsApp formatting (bold, headings → `*…*`; strips link syntax).
6. `formatSources()` renders source URLs as `🔗 <url>` lines appended to the reply.
7. Reply is sent quoted to the original message.

**Reconnection:** `connection.update` handler calls `startBot()` recursively on disconnect unless the disconnect reason is `loggedOut`.

**Noise suppression:** Baileys logs harmless libsignal decryption errors (`Bad MAC`, `Failed to decrypt`) from other devices' sessions to `console.error` — these are intercepted and silenced.

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `QUERY_SERVICE_URL` | `http://localhost:3000` | Base URL of the Query-Service |
| `GROUP_JID` | *(optional)* | Restrict bot to one group (`120363…@g.us`). If unset, responds in all groups. |

`.env` is gitignored. Copy `.env.example` to `.env`.

## Key Decisions

- **LID vs. phone number mentions:** WhatsApp (newer versions) uses LIDs (`lid` credential field) instead of phone numbers in `mentionedJid` lists. The bot checks both `botPhone` and `botLid` to detect @mentions reliably. See commit `b5960aa`.
- **`network_mode: host`** in `docker-compose.yml`: required so the container can reach the Query-Service on `localhost:3000` without additional Docker networking config.
- **`auth/` is gitignored** and mounted as a host volume — losing it requires re-scanning the QR code.
- **TypeScript via `tsx`**, no compile step. `moduleResolution: bundler` in `tsconfig.json`.
