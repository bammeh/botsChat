# Gateway Loopback WebSocket

This document provides detailed technical documentation for the Gateway Loopback WebSocket implementation in the BotsChat plugin.

## Overview

The Gateway Loopback WebSocket enables the BotsChat plugin to connect directly to the OpenClaw gateway as a WebSocket client, receiving real-time streaming events from agent execution. This replaces the traditional `dispatchReplyFromConfig` in-process dispatch mechanism with a more robust event-driven approach.

## Connection Lifecycle

### 1. Connection Establishment

```typescript
const gatewayClient = new GatewayWsClient({
  port: 18789,
  host: "127.0.0.1",
  token: process.env.OPENCLAW_GATEWAY_TOKEN,
  allowInsecureAuth: false,
  accountId: "default",
  onEvent: (frame) => handleGatewayEvent(frame),
  onConnected: () => console.log("Connected"),
  onDisconnected: () => console.log("Disconnected"),
});
```

### 2. Handshake Sequence

1. **Client connects** to `ws://127.0.0.1:18789`
2. **Gateway sends** `connect.challenge` with `{ nonce, ts }`
3. **Client responds** with `connect` message:
   ```json
   {
     "type": "connect",
     "role": "operator",
     "scopes": ["operator.read", "operator.write"],
     "caps": ["tool-events"],
     "auth": { "token": "..." },
     "device": { "id": "botschat-gateway-{accountId}" }
   }
   ```
4. **Gateway confirms** with connect response

### 3. Keep-Alive

The client maintains the connection with periodic ping messages (every 30 seconds).

## Event Mapping Reference

### Gateway Events → Cloud Messages

| Gateway Event | Cloud Message | Description |
|--------------|---------------|-------------|
| `agent` stream `reply` phase=start | `agent.stream.start` | Agent begins streaming |
| `agent` stream `reply` text present | `agent.stream.chunk` | Text chunk from agent |
| `agent` stream `reply` phase=result | `agent.text` + `agent.stream.end` | Final text and stream end |
| `agent` stream `tool` phase=result name=sessions_spawn | `agent.delegation.spawned` | Sub-agent spawned |

### Detailed Event Structure

#### Reply Stream Events

```typescript
// Stream Start
{
  type: "event",
  event: "agent",
  payload: {
    stream: "reply",
    data: { phase: "start" },
    sessionKey: "agent:main:botschat:account:...",
    runId: "run_1234567890_abc"
  }
}

// Stream Chunk
{
  type: "event",
  event: "agent",
  payload: {
    stream: "reply",
    data: { text: "Hello, how can I..." },
    sessionKey: "...",
    runId: "..."
  }
}

// Stream End
{
  type: "event",
  event: "agent",
  payload: {
    stream: "reply",
    data: { phase: "result", text: "Full response text..." },
    sessionKey: "...",
    runId: "..."
  }
}
```

#### Tool Events

```typescript
// Tool Start
{
  type: "event",
  event: "agent",
  payload: {
    stream: "tool",
    data: {
      phase: "start",
      name: "web_search"
    },
    sessionKey: "...",
    runId: "..."
  }
}

// Tool Result
{
  type: "event",
  event: "agent",
  payload: {
    stream: "tool",
    data: {
      phase: "result",
      name: "sessions_spawn",
      result: {
        runId: "run_child_...",
        childSessionKey: "agent:linear:subagent:uuid",
        label: "Sub-agent Label",
        task: "Task description..."
      }
    },
    sessionKey: "...",
    runId: "..."
  }
}
```

### Cloud Outbound Messages

#### agent.stream.start

```typescript
{
  type: "agent.stream.start",
  sessionKey: string,
  runId: string
}
```

#### agent.stream.chunk

```typescript
{
  type: "agent.stream.chunk",
  sessionKey: string,
  runId: string,
  text: string
}
```

#### agent.text

```typescript
{
  type: "agent.text",
  sessionKey: string,
  text: string
}
```

#### agent.stream.end

```typescript
{
  type: "agent.stream.end",
  sessionKey: string,
  runId: string
}
```

#### agent.delegation.spawned

```typescript
{
  type: "agent.delegation.spawned",
  sessionKey: string,
  runId: string,
  childSessionKey: string,
  label?: string,
  task?: string
}
```

## RPC Methods

### chat.send

Start an agent run via the gateway:

```typescript
const response = await gatewayClient.send("chat.send", {
  sessionKey: "agent:main:botschat:account:thread:123",
  body: "User message text",
  mediaUrl: "https://...",  // optional
  threadId: "thread-123",   // optional
  verboseLevel: "full",     // required for tool result data
  runId: "run_1234567890_abc"
});
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionKey` | string | Yes | Agent session identifier |
| `body` | string | Yes | User message text |
| `mediaUrl` | string | No | URL for media attachments |
| `threadId` | string | No | Thread ID for threaded conversations |
| `verboseLevel` | string | No | Set to `"full"` for complete tool results |
| `runId` | string | No | Custom run ID for correlation |

## Authentication

### Token-Based Authentication

```json
{
  "gateway": {
    "auth": {
      "token": "your-secure-token"
    }
  }
}
```

Or via environment variable:
```bash
export OPENCLAW_GATEWAY_TOKEN=your-secure-token
```

### Insecure Authentication (Local Only)

For local development, you can bypass token requirements:

```json
{
  "gateway": {
    "controlUi": {
      "allowInsecureAuth": true
    }
  }
}
```

**⚠️ Warning:** Never enable `allowInsecureAuth` in production or on network-accessible systems.

## Error Handling

### Connection Errors

```typescript
gatewayClient.connect().catch((err) => {
  console.warn("Gateway WS connection failed:", err);
  // Plugin automatically falls back to dispatchReplyFromConfig
});
```

### RPC Errors

```typescript
try {
  await gatewayClient.send("chat.send", params);
} catch (err) {
  if (err.code === "TIMEOUT") {
    // Request timed out
  } else if (err.code === "AUTH_FAILED") {
    // Authentication failed
  }
  // Fall back to in-process dispatch
}
```

## Troubleshooting

### Connection Refused

**Symptom:** WebSocket connection fails with "Connection refused"

**Diagnosis:**
```bash
# Check if gateway is running
openclaw gateway status

# Check if port is listening
netstat -an | grep 18789
```

**Solutions:**
1. Start the gateway: `openclaw gateway start`
2. Verify port matches config (default: 18789)
3. Check firewall rules

### Authentication Failed

**Symptom:** Connection established but handshake fails

**Diagnosis:**
```bash
# Check gateway logs
openclaw gateway logs

# Verify token is set
echo $OPENCLAW_GATEWAY_TOKEN
```

**Solutions:**
1. Set valid token in config or environment
2. Enable `allowInsecureAuth` for local development
3. Verify token matches gateway configuration

### Fallback to dispatchReplyFromConfig

**Symptom:** Logs show "Gateway not connected, using in-process dispatch"

**Diagnosis:**
1. Check gateway WebSocket URL in config
2. Verify gateway is accessible at the configured host/port
3. Check for proxy or network issues

**Solutions:**
1. Fix gateway connectivity
2. Verify `gatewayWsUrl` configuration
3. Check network connectivity

### Missing Delegation Events

**Symptom:** `agent.delegation.spawned` events not received

**Diagnosis:**
1. Check if `verboseLevel: "full"` is passed to `chat.send`
2. Verify gateway has `caps: ["tool-events"]` in connect message

**Solutions:**
1. Ensure `verboseLevel: "full"` in RPC params
2. Check gateway version supports tool events
3. Verify plugin is using latest GatewayWsClient

### Intermittent Disconnections

**Symptom:** Connection drops sporadically

**Diagnosis:**
1. Check gateway logs for errors
2. Monitor network stability
3. Verify ping/pong mechanism is working

**Solutions:**
1. Check gateway resource limits
2. Increase ping interval if needed
3. Implement reconnection logic (automatic in plugin)

## Performance Considerations

### Connection Pooling

One `GatewayWsClient` is created per BotsChat account. For multiple accounts, each maintains its own connection.

### Event Throughput

Events are processed synchronously in the `onEvent` callback. For high-volume scenarios, consider:
- Batching UI updates
- Throttling stream chunks
- Using a queue for non-critical events

### Memory Usage

The client maintains minimal state:
- Pending request map (cleared on response/timeout)
- Connection state flags
- Ping interval timer

## Security Considerations

### Token Storage

Store tokens securely:
- Use environment variables, not hardcoded values
- Rotate tokens periodically
- Use different tokens for different environments

### Network Security

For production:
- Use TLS (wss://) for remote connections
- Restrict gateway bind address
- Use firewall rules to limit access
- Never expose gateway port publicly

### Loopback Only

The default configuration uses `127.0.0.1` for loopback connections. This ensures:
- Traffic stays on local machine
- No external network exposure
- Minimal attack surface

## Debugging

### Enable Verbose Logging

```typescript
const gatewayClient = new GatewayWsClient({
  // ... other options
  log: {
    info: (...args) => console.log("[GW]", ...args),
    warn: (...args) => console.warn("[GW]", ...args),
    error: (...args) => console.error("[GW]", ...args),
  },
});
```

### Inspect Raw Messages

Log all incoming/outgoing WebSocket frames for debugging connection issues.

### Gateway Logs

Check gateway logs for server-side issues:
```bash
openclaw gateway logs --follow
```
