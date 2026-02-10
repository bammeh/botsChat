# Option 1: Plugin as Loopback WebSocket Client — Implementation Plan

## Goal

Make the BotsChat plugin connect to the OpenClaw gateway's WebSocket as a client (with `caps: ["tool-events"]`) and start agent runs via that connection, instead of using `runtime.channel.reply.dispatchReplyFromConfig`. This delivers full tool-event streams (`start`, `update`, `result`) for all tools, including `sessions_spawn`, without requiring `verbose=full`.

---

## Architecture Change

**Current flow:**
```
Cloud → Plugin (onMessage) → dispatchReplyFromConfig() → Agent runs in-process
                            → deliver callback receives text/tool results (parsed)
                            → Plugin → Cloud
```

**New flow:**
```
Cloud → Plugin (onMessage) → GatewayWsClient.send() → Gateway WebSocket
                            → chat.send (or agent) RPC
                            → Agent runs
                            → Events stream back on same connection
                            → Plugin handles event:agent, stream:tool
                            → Plugin → Cloud
```

---

## Phase 1: Discovery & Proto

### 1.1 Gateway WebSocket Endpoint

- **Default URL:** `ws://127.0.0.1:18789` (from `gateway.port`, default 18789)
- **Config source:** Read from `~/.openclaw/openclaw.json` → `gateway.port`, or `gateway.bind` for host
- **Fallback:** Env `OPENCLAW_GATEWAY_PORT` or assume 18789

### 1.2 Connect Handshake

From [Gateway Protocol](https://docs.clawd.bot/gateway/protocol):

1. **Gateway sends:** `connect.challenge` with `nonce`, `ts`
2. **Client sends:** `connect` request with:
   - `role: "operator"`
   - `scopes: ["operator.read", "operator.write"]`
   - **`caps: ["tool-events"]`** ← critical for tool events
   - `auth: { token: "..." }` if `OPENCLAW_GATEWAY_TOKEN` set
   - `device` identity (required unless `gateway.controlUi.allowInsecureAuth`)
3. **Gateway sends:** `connect` response with `hello-ok` or error

### 1.3 Auth Options for Loopback

| Scenario | Approach |
|----------|----------|
| No token set | `gateway.controlUi.allowInsecureAuth: true` (local only) — may allow connect without device |
| Token set | `connect.params.auth.token` = `OPENCLAW_GATEWAY_TOKEN` |
| Device required | Generate stable `device.id` (e.g. `botschat-plugin-{accountId}`), sign challenge if needed |

**Action:** Inspect OpenClaw source for `controlUi.allowInsecureAuth` behavior and minimal loopback auth.

### 1.4 Start Run: `chat.send` or `agent`

WebChat uses `chat.send`, `chat.history`, `chat.inject`. Need to find exact RPC:

- **Method:** `chat.send` (or `agent` for raw dispatch)
- **Params (likely):** `sessionKey`, `body`, `mediaUrl?`, `threadId?`, `verboseLevel?: "full"`

**Action:** Search OpenClaw repo for `chat.send` schema and params. Ensure `verboseLevel: "full"` is passed so `data.result` is present in tool events.

### 1.5 Tool Event Structure

From OpenClaw support:
```
frame.type === "event"
frame.event === "agent"
frame.payload.stream === "tool"
frame.payload.data.phase === "start" | "update" | "result"
frame.payload.data.name === "sessions_spawn"  // or other tool name
frame.payload.data.result  // when phase=result and verbose=full
```

---

## Phase 2: Implementation

### 2.1 New Module: `gateway-ws-client.ts`

Create `packages/plugin/src/gateway-ws-client.ts`:

**Responsibilities:**
- Connect to `ws://127.0.0.1:{port}` (or config)
- Handle `connect.challenge` → respond with `connect` + auth
- Maintain connection with ping/pong
- Send RPC requests (`chat.send`), track request IDs
- Emit events to callback: `onEvent(frame)`

**API:**
```ts
export type GatewayWsClientOptions = {
  port?: number;
  host?: string;
  token?: string;
  allowInsecureAuth?: boolean;
  onEvent: (frame: GatewayEvent) => void;
  onConnected: () => void;
  onDisconnected: () => void;
  log?: { info, warn, error };
};

export class GatewayWsClient {
  connect(): void;
  disconnect(): void;
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
  get connected(): boolean;
}
```

**Key details:**
- Generate `device.id`: `botschat-gateway-{accountId}` for stability
- Store challenge nonce/ts for signing if required
- Request/response correlation via `id` field

### 2.2 Integrate into Channel Flow

**Option A: Replace dispatch path**

- When `handleCloudMessage` receives `user.message`:
  - Call `gatewayClient.send("chat.send", { sessionKey, body, ... })` instead of `dispatchReplyFromConfig`
  - Handle streaming events in `onEvent`:
    - `event: "agent"`, `stream: "reply"` → forward text to cloud as `agent.text` / `agent.stream.chunk`
    - `event: "agent"`, `stream: "tool"`, `phase: "result"`, `name: "sessions_spawn"` → emit `agent.delegation.spawned`
    - Other tools → optional: emit generic `agent.tool.result` for UI

**Option B: Dual-path (fallback)**

- Try gateway WebSocket first; if connect fails or send fails, fall back to `dispatchReplyFromConfig`
- Allows graceful degradation if gateway doesn't support or auth fails

**Recommendation:** Start with Option A, add Option B if discovery shows auth is tricky.

### 2.3 Per-Account vs Single Connection

- **One connection per account:** Each BotsChat account (cloud user) gets its own `GatewayWsClient`. Runs started by that connection receive tool events.
- **Single connection:** One shared connection; need to map `sessionKey` to accountId for routing. Simpler but may have routing edge cases.

**Recommendation:** One `GatewayWsClient` per `BotsChatCloudClient` (per account). Start gateway WS when starting cloud client in `gateway.startAccount`.

### 2.4 Event → Cloud Mapping

| Gateway Event | Cloud Outbound |
|---------------|----------------|
| `agent` stream `reply` (text) | `agent.text`, `agent.stream.chunk`, `agent.stream.end` |
| `agent` stream `tool` phase=result name=sessions_spawn | `agent.delegation.spawned` |
| `agent` stream `tool` (other) | Optional: `agent.tool.result` for future UI |
| Media | `agent.media` (when applicable) |

### 2.5 Config

Add optional plugin config for gateway URL override:

```json
"channels": {
  "botschat": {
    "gatewayWsUrl": "ws://127.0.0.1:18789"
  }
}
```

Default: derive from `gateway.port` (read from `openclaw.json` or env).

---

## Phase 3: Testing & Rollout

### 3.1 Unit Tests

- Mock WebSocket server that sends `connect.challenge`, accepts `connect`, echoes `chat.send`
- Verify tool-event parsing and delegation emission

### 3.2 Integration Tests

- Run real gateway, connect plugin, send message, verify tool events received
- Test with `sessions_spawn` specifically

### 3.3 Backward Compatibility

- Keep `api.on("after_tool_call")` as fallback for delegation when gateway WS is unavailable
- Document: "If gateway WebSocket fails to connect, delegation cards may not appear unless verbose=full"

---

## Phase 4: Future Enhancements

- **All tool events in UI:** Emit `agent.tool.result` for every tool; extend cloud protocol and React store to show tool activity (e.g. "🔧 web_search", "🔧 read_file")
- **Tool progress:** Use `phase: "update"` for long-running tools (e.g. exec) to show partial output
- **Config flag:** `channels.botschat.useGatewayWs: true` to opt in, default `false` until stable

---

## Dependencies & Risks

| Dependency | Risk |
|------------|------|
| OpenClaw protocol stability | Schema may change; version check in connect |
| Auth requirements | `allowInsecureAuth` might be removed; need token path |
| chat.send params | Undocumented; may require source dive |
| Verbose level | Must pass `verboseLevel: "full"` in chat.send for result body |

---

## Implementation Order

1. **Phase 1.4** — Resolve `chat.send` / `agent` RPC schema (source or docs)
2. **Phase 1.3** — Confirm loopback auth options
3. **Phase 2.1** — Implement `GatewayWsClient` with connect + send
4. **Phase 2.2** — Wire into `handleCloudMessage` for one message type
5. **Phase 2.4** — Map tool events to cloud protocol
6. **Phase 3** — Test and iterate

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `packages/plugin/src/gateway-ws-client.ts` | **Create** — Gateway WebSocket client |
| `packages/plugin/src/channel.ts` | **Modify** — Use GatewayWsClient in handleCloudMessage, add gateway WS lifecycle |
| `packages/plugin/src/types.ts` | **Modify** — Add `agent.tool.result` if desired |
| `packages/plugin/openclaw.plugin.json` | **Modify** — Add `gatewayWsUrl` to configSchema if needed |
| `docs/option-1-gateway-loopback-plan.md` | **Create** — This plan |
