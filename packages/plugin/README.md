# BotsChat Plugin

A channel plugin for OpenClaw that provides cloud-based multi-channel chat integration.

## Architecture

### Gateway Loopback WebSocket

The BotsChat plugin uses a **Gateway Loopback WebSocket** connection to stream agent events directly to the cloud, enabling real-time tool-event streaming without requiring `verbose=full`.

#### Old vs New Flow

**Old Flow (dispatchReplyFromConfig):**
```
Cloud → Plugin → dispatchReplyFromConfig() → Agent runs in-process
              → deliver callback receives text/tool results (parsed)
              → Plugin → Cloud
```

**New Flow (Gateway WebSocket):**
```
Cloud → Plugin → GatewayWsClient → Gateway WebSocket
              → chat.send RPC
              → Agent runs
              → Events stream back on same connection
              → Plugin handles event:agent, stream:tool
              → Plugin → Cloud
```

#### Benefits

- **Full tool-event streaming**: Receives `start`, `update`, and `result` phases for all tools
- **No verbose=full needed**: Tool results are available without special flags
- **Proper delegation rendering**: `sessions_spawn` results are correctly emitted as `agent.delegation.spawned`
- **Real-time streaming**: Agent text chunks stream to the cloud immediately

## Configuration

### Basic Setup

Configure BotsChat in your `openclaw.json`:

```json
{
  "channels": {
    "botschat": {
      "enabled": true,
      "cloudUrl": "https://console.botschat.app",
      "pairingToken": "your-pairing-token"
    }
  }
}
```

### Gateway WebSocket Configuration

The Gateway WebSocket URL is automatically derived from your gateway configuration. You can optionally override it:

```json
{
  "channels": {
    "botschat": {
      "gatewayWsUrl": "ws://127.0.0.1:18789"
    }
  },
  "gateway": {
    "port": 18789,
    "auth": {
      "token": "your-gateway-token"
    },
    "controlUi": {
      "allowInsecureAuth": true
    }
  }
}
```

#### Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| `gatewayWsUrl` | WebSocket URL for gateway connection | Derived from `gateway.port` |
| `gateway.port` | Port for gateway WebSocket | `18789` |
| `gateway.bind` | Host for gateway WebSocket | `127.0.0.1` |
| `gateway.auth.token` | Authentication token for gateway | From `OPENCLAW_GATEWAY_TOKEN` env |
| `gateway.controlUi.allowInsecureAuth` | Allow connections without token (local only) | `false` |

## Setup Requirements

1. **OpenClaw Gateway Must Be Running**

   The gateway provides the WebSocket endpoint for event streaming:
   ```bash
   openclaw gateway start
   ```

2. **Authentication**

   One of the following is required:
   - **Token auth**: Set `gateway.auth.token` in config or `OPENCLAW_GATEWAY_TOKEN` environment variable
   - **Insecure auth**: Enable `gateway.controlUi.allowInsecureAuth: true` for local loopback (not recommended for production)

3. **Port Configuration**

   Default port is `18789`. Ensure this matches between:
   - `gateway.port` in `openclaw.json`
   - `channels.botschat.gatewayWsUrl` (if explicitly set)
   - Any firewall rules

4. **BotsChat Cloud Connection**

   Obtain a pairing token from the BotsChat cloud dashboard:
   ```bash
   openclaw channel setup botschat --url console.botschat.app --token <pairing-token>
   ```

## Event Flow

### Agent Reply Streaming

When an agent generates a response:

1. `agent.stream.start` — Indicates streaming has begun
2. `agent.stream.chunk` — Individual text chunks as generated
3. `agent.text` — Final complete text
4. `agent.stream.end` — Streaming complete

### Tool Event Streaming

Tool executions emit detailed events:

1. **Tool Start**: `phase: "start"` — Tool invocation begins
2. **Tool Update**: `phase: "update"` — Progress updates (for long-running tools)
3. **Tool Result**: `phase: "result"` — Final result with data

### Delegation Events

When `sessions_spawn` is used to spawn sub-agents:

```json
{
  "type": "agent.delegation.spawned",
  "sessionKey": "agent:main:botschat:account:thread:123",
  "runId": "run_1234567890_abc123",
  "childSessionKey": "agent:linear:subagent:uuid",
  "label": "Task Label",
  "task": "Task description..."
}
```

## Backward Compatibility

The plugin maintains full backward compatibility:

- **Fallback to dispatchReplyFromConfig**: If the gateway WebSocket is unavailable, the plugin automatically falls back to the in-process dispatch mechanism
- **No breaking changes to cloud protocol**: Existing accounts and integrations continue to work
- **Configuration-free migration**: Existing accounts work without any config changes

### Fallback Behavior

When the gateway WebSocket connection fails:

1. Plugin logs a warning
2. Falls back to `dispatchReplyFromConfig` 
3. Tool results are still captured via `after_tool_call` hook
4. Delegation events are emitted from parsed tool results

## Development

### File Structure

```
packages/plugin/
├── src/
│   ├── channel.ts           # Main channel plugin definition
│   ├── gateway-ws-client.ts # Gateway WebSocket client
│   ├── ws-client.ts         # Cloud WebSocket client
│   ├── accounts.ts          # Account management
│   ├── runtime.ts           # Runtime utilities
│   └── types.ts             # TypeScript types
├── docs/
│   └── gateway-websocket.md # Detailed WebSocket documentation
└── README.md                # This file
```

### Key Components

- **GatewayWsClient**: Manages WebSocket connection to OpenClaw gateway
- **BotsChatCloudClient**: Manages WebSocket connection to BotsChat cloud
- **handleCloudMessage**: Routes incoming cloud messages to appropriate handlers
- **handleGatewayEvent**: Processes streaming events from the gateway

## Troubleshooting

See [docs/gateway-websocket.md](./docs/gateway-websocket.md) for detailed troubleshooting guide.

### Common Issues

| Issue | Solution |
|-------|----------|
| Connection refused | Check gateway is running: `openclaw gateway status` |
| Auth failed | Verify token in config or enable `allowInsecureAuth` |
| Fallback to dispatchReplyFromConfig | Check gateway WebSocket URL and connectivity |
| Missing delegation events | Ensure `verboseLevel: "full"` is passed to chat.send |
