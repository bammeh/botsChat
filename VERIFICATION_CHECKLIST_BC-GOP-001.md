# Verification Checklist - BC-GOP-001

## Pre-Compilation Checks

### File Existence
- [ ] `/home/openclaw/.openclaw/botsChat/packages/plugin/src/config.ts` exists
- [ ] `/home/openclaw/.openclaw/botsChat/packages/plugin/src/identity.ts` exists
- [ ] `/home/openclaw/.openclaw/botsChat/packages/plugin/src/gateway-operator-client.ts` exists
- [ ] `/home/openclaw/.openclaw/botsChat/packages/plugin/src/channel.ts` modified

### TypeScript Strict Mode Verification

#### config.ts
```typescript
// Check that all types are properly exported
export interface GatewayConfig { ... }
export function readGatewayConfig(): GatewayConfig { ... }
export function getGatewayUrl(): string { ... }
export function getDeviceKeyPath(): string { ... }
```
- [ ] No implicit `any` types
- [ ] All parameters are typed
- [ ] All return types are explicit
- [ ] No unused variables

#### identity.ts
```typescript
// Check that all crypto operations are properly typed
export interface Ed25519Keypair { ... }
export interface DeviceIdentity { ... }
export function generateEd25519Keypair(): Ed25519Keypair { ... }
export function signMessage(message: string, privateKey: Buffer): string { ... }
```
- [ ] Buffer operations are properly typed
- [ ] File system operations have error handling
- [ ] All functions have explicit return types
- [ ] File permissions use correct octal type

#### gateway-operator-client.ts
```typescript
// Check that WebSocket and protocol messages are properly typed
export interface ConnectChallengeMessage { ... }
export interface ConnectRequestMessage { ... }
export interface EventMessage { ... }
export class GatewayOperatorClient { ... }
```
- [ ] WebSocket event handlers are properly typed
- [ ] Protocol message types are discriminated correctly
- [ ] All async functions return Promise<T>
- [ ] Map types are properly parameterized
- [ ] No implicit any in message handlers

#### channel.ts
```typescript
// Check that imports and types are updated
import GatewayOperatorClient, { type EventMessage } from "./gateway-operator-client.js";
const gatewayOperatorClients = new Map<string, GatewayOperatorClient>();
```
- [ ] Old imports are updated
- [ ] New imports are correctly added
- [ ] Type unions are properly defined
- [ ] No type conflicts between old and new clients

## Compilation Commands

Run from `/home/openclaw/.openclaw/botsChat/packages/plugin`:

```bash
# Full TypeScript compilation
npm run build

# Development mode with watch
npm run dev

# Type checking only
tsc --noEmit

# Strict mode verification
tsc --strict
```

## Expected Build Output

### Success Indicators
- `dist/` directory created with `.js` and `.d.ts` files
- No TypeScript errors
- Declaration files generated for new modules

### Expected Generated Files
```
dist/src/
├── config.js + config.d.ts
├── identity.js + identity.d.ts
├── gateway-operator-client.js + gateway-operator-client.d.ts
├── channel.js + channel.d.ts (modified)
└── ... (existing files)
```

## Runtime Verification

### Test 1: Device Key Generation
```bash
# Remove existing key
rm -f ~/.config/botschat/device.key

# Start the plugin
openclaw channel start botschat

# Verify key was created
ls -l ~/.config/botschat/device.key
# Expected: -rw------- (600 permissions)
```

### Test 2: Gateway Connection
```bash
# Ensure Gateway is running
openclaw gateway status

# Start the plugin
openclaw channel start botschat

# Check logs for:
# - "Device ID: dev:..."
# - "WebSocket connected"
# - "Received connect.challenge"
# - "Handshake complete"
# - "Sent system-presence"
```

### Test 3: Message Flow
```bash
# Send a message via BotsChat cloud
# Expected behavior:
# 1. Plugin receives user.message from cloud
# 2. Plugin forwards to Gateway via chat.send RPC
# 3. Gateway processes and streams agent events
# 4. Plugin forwards events to cloud
# 5. User sees agent response in cloud UI
```

### Test 4: Reconnect Logic
```bash
# Start plugin
openclaw channel start botschat

# Stop Gateway
openclaw gateway stop

# Wait for reconnect attempt (check logs for "Reconnecting in Xms")
# Should see backoff increasing: 1000ms, 2000ms, 4000ms...

# Start Gateway again
openclaw gateway start

# Plugin should reconnect automatically
```

### Test 5: Fallback Mode
```bash
# Ensure Gateway is NOT running
openclaw gateway stop

# Start plugin
openclaw channel start botschat

# Send message via cloud
# Expected:
# - Plugin logs "Gateway not ready, using in-process dispatch"
# - Message is processed in-process
# - Response is delivered to cloud
```

## Common Issues and Solutions

### Issue: "Cannot find module './gateway-operator-client.js'"
**Solution:** Ensure the file is compiled and the `.js` extension is used in import

### Issue: "Property 'ready' does not exist on type..."
**Solution:** Update type reference to use `GatewayOperatorClient` type

### Issue: "Type 'EventMessage' is not assignable to type 'GatewayEvent'"
**Solution:** Update union type in `handleGatewayEvent()` to accept both types

### Issue: "Buffer types incompatible"
**Solution:** Ensure Node.js types are installed: `npm install @types/node`

### Issue: "File not found: ~/.config/botschat/device.key"
**Solution:** The plugin auto-generates the key if it doesn't exist. Check permissions.

## Performance Validation

### Memory Usage
- Monitor memory before and after connecting to Gateway
- Expected: Minimal increase (few MB for WebSocket buffers)

### CPU Usage
- Monitor CPU during idle state
- Expected: Low (< 1% with ping/pong keepalive)

### Connection Time
- Measure time from plugin start to handshake complete
- Expected: < 2 seconds

### Reconnect Time
- Measure time from Gateway stop to successful reconnect
- Expected: < 5 seconds (plus backoff)

## Security Validation

### Key File Permissions
```bash
ls -l ~/.config/botschat/device.key
# Expected: -rw-------
```

### Device ID Uniqueness
- Delete key and restart plugin
- Verify new device ID is generated

### Challenge Signature
- Check logs for "Sending connect response with signature"
- Verify signature is 64 hex characters (256 bits)

### Protocol Version
- Check logs for "Handshake complete: protocol=3"
- Verify version negotiation succeeded

## Integration Points

### With Existing Plugin APIs
- [ ] `startAccount()` works without changes to plugin config
- [ ] `stopAccount()` cleanly disconnects both clients
- [ ] `handleCloudMessage()` routes correctly
- [ ] `handleGatewayEvent()` processes all event types

### With BotsChat Cloud
- [ ] Cloud WSS connection still works
- [ ] Authentication with pairing token works
- [ ] User messages are received
- [ ] Agent responses are sent
- [ ] Streaming events work

### With OpenClaw Gateway
- [ ] WebSocket connection succeeds
- [ ] Handshake completes
- [ ] System presence appears in Gateway UI
- [ ] RPC requests work
- [ ] Agent events stream correctly
- [ ] Exec approval requests are received

## Acceptance Criteria Final Check

- [ ] Plugin generates/stores Ed25519 keypair at `~/.config/botschat/device.key`
- [ ] Sends proper `connect` request with `role: "operator"` and `scopes: ["operator.read", "operator.write"]`
- [ ] Handles `connect.challenge`, signs nonce with device key, includes in connect response
- [ ] Negotiates protocol version (minProtocol: 3, maxProtocol: 3)
- [ ] Receives and processes `hello-ok` response
- [ ] Maintains persistent WebSocket connection with auto-reconnect
- [ ] Successfully appears in Gateway `system-presence`
- [ ] Can receive exec approval requests from Gateway
- [ ] Maintains backward compatibility with existing ConnectionDO behavior

## Linear Update Required

Update BC-GW series tasks in Linear to mark BC-GOP-001 as completed.
