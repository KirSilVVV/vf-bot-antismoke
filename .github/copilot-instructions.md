# VF-Bot-Antismoke: AI Coding Agent Guidelines

## Project Overview
**vf-bot-antismoke** is a TypeScript/Fastify server that bridges **Telegram** ↔ **Voiceflow** conversational AI. Users message a Telegram bot, the backend calls Voiceflow's runtime API, and responses with buttons are sent back to Telegram.

### Core Architecture
- **Fastify server** (src/index.ts) with three route modules
- **Voiceflow Runtime API** integration (services/voiceflowRuntime.ts)
- **Telegram Bot API** integration (routes/telegram.ts)
- **Environment-driven config** with Zod validation (config/env.ts)

---

## Critical Data Flows

### 1. User Message → Voiceflow → Response
```
Telegram webhook POST /api/telegram/webhook
  → Zod parse UpdateSchema
  → markSeen() anti-replay check
  → voiceflowInteract({userId, text})  
    → POST to Voiceflow General Runtime
    → Parse VFMessage[] (text/speak/choice/buttons)
    → Extract buttons with payload handling
  → telegramSendMessage(chatId, text, buttons)
    → Inline keyboard with 64-byte callback_data limit
```

### 2. Button Click → Voiceflow Interaction
```
Telegram callback_query
  → Extract callback_data (may be token or raw payload)
  → getCallbackPayload(token) resolves from cbStore
  → voiceflowInteract({userId, text: payload})
  → Send response back to Telegram
```

---

## Key Implementation Patterns

### Anti-Replay Mechanism
- **In-memory Map** (`seen`) stores update/message/callback IDs for 5 minutes
- **Three-layer protection**: `u:{update_id}`, `m:{chatId}:{messageId}`, `c:{callbackId}`
- `markSeen()` auto-cleans expired entries when size > 5000
- **Why**: Telegram retries webhooks; Voiceflow may echo; prevents duplicate processing

### Callback Payload Storage
- Telegram `callback_data` ≤ 64 bytes UTF-8
- Voiceflow often sends large payloads → stored in `cbStore` Map with token
- Tokens: `{timestamp}_{randomId}` with 10-minute TTL
- `getCallbackPayload()` returns raw payload if token invalid/expired
- **Why**: Fixes "Sorry, I didn't get that" errors when buttons have complex data

### Voiceflow Response Parsing
- VF returns **array of messages** with different types: `text`, `speak`, `choice`, `buttons`
- Text can appear in: `item.text` OR `item.messages[].payload.message`
- Buttons need extraction from `choice`/`buttons` message types
- `payloadToString()` handles non-string payloads (objects serialized to JSON)
- De-duplication: `pushUniqueText()` prevents repeating similar text lines

### Telegram Integration
- **Immediate response** to webhook (reply before async work) prevents retries
- **Bold**: Unsafe text input → wrapped in `safeText.toString().trim()`
- Inline keyboards mapped from VF buttons
- Special `/start` command launches VF flow (not just sends text)
- `/help` command shows available actions

---

## Environment Configuration (Zod)
Located in [src/config/env.ts](src/config/env.ts):
```typescript
TELEGRAM_BOT_TOKEN       // Required: Telegram bot token
VOICEFLOW_API_KEY        // Required: Auth for VF runtime
VOICEFLOW_VERSION_ID     // Required: VF bot version ID
VOICEFLOW_WEBHOOK_SECRET // Required: Validate incoming VF webhooks
PORT                     // Default: 3000 (Render requires 0.0.0.0:PORT)
NODE_ENV                 // Default: 'development'
OPENAI_API_KEY          // Optional: Not yet used
```
All env vars parsed at startup; missing required keys throw error immediately.

---

## Build & Run
```bash
npm run build  # tsc -p tsconfig.json → outputs to dist/
npm start      # node dist/index.js
```
TypeScript strict mode enabled; no implicit any.

---

## Route Modules

### /health (health.ts)
Simple liveness probe: `GET /health` → `{ ok: true }`

### /api/telegram/webhook (telegram.ts)
Handles both `message` and `callback_query` updates. Immediate `{ ok: true }` response, then async processing. Anti-replay + error handling with user-friendly messages.

### /api/voiceflow/webhook (voiceflow.ts)
**Not yet fully implemented** — only validates secret and logs. Would be used if Voiceflow initiates messages to backend. Requires `x-vf-secret` header validation.

---

## Common Gotchas & Patterns

1. **Always respond Telegram webhook immediately** — `reply.send()` before async work
2. **Callback payload length** — if button data > 60 bytes, use `putCallbackPayload()`
3. **VF text extraction** — check both `item.text` AND `item.messages[].payload.message`
4. **Button deduplication** — VF may repeat buttons; don't assume order/uniqueness
5. **User ID scoping** — use `userId = String(update.from?.id ?? chatId)` to ensure string
6. **Empty VF responses** — return `{ text: '…', buttons: [] }` if neither text nor buttons present
7. **Timezone/env issues** — `.env.example` provided; always test with real values

---

## Files to Know
- **[src/routes/telegram.ts](src/routes/telegram.ts)** — Telegram webhook logic (245 lines, core complexity)
- **[src/services/voiceflowRuntime.ts](src/services/voiceflowRuntime.ts)** — VF API client + response parsing
- **[src/config/env.ts](src/config/env.ts)** — Environment schema
- **[src/index.ts](src/index.ts)** — Fastify setup + route registration
- **[package.json](package.json)** — Dependencies: fastify, zod, dotenv

---

## External API Endpoints (Not Changeable)
- `https://api.telegram.org/bot{TOKEN}/sendMessage` — Send messages + inline keyboards
- `https://api.telegram.org/bot{TOKEN}/answerCallbackQuery` — "Dismiss" button loading
- `https://general-runtime.voiceflow.com/state/{VERSION_ID}/user/{userID}/interact` — Voiceflow conversation
