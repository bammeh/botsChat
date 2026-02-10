import { botschatPlugin, emitBotsChatDelegationFromToolResult } from "./src/channel.js";
import { setBotsChatRuntime } from "./src/runtime.js";

// OpenClaw Plugin Definition
// This is the entry point loaded by OpenClaw's plugin system.
// It registers the BotsChat channel plugin.
const plugin = {
  id: "botschat",
  name: "BotsChat",
  description: "Connect to BotsChat cloud chat platform",
  configSchema: { safeParse: () => ({ success: true }) },
  register(api: {
    runtime: unknown;
    registerChannel: (reg: { plugin: typeof botschatPlugin }) => void;
    on?: (event: string, handler: (event: { toolName?: string; sessionKey?: string; result?: unknown }) => void) => void;
    logger?: { info: (m: string) => void };
  }) {
    setBotsChatRuntime(api.runtime);
    api.registerChannel({ plugin: botschatPlugin });

    // Hook into tool completion to detect sessions_spawn and emit delegation to cloud.
    // This gives us structured runId/childSessionKey without parsing text or requiring verbose=full.
    if (typeof api.on === "function") {
      api.on("after_tool_call", (event) => {
        const toolName = event.toolName ?? (event as { name?: string }).name;
        if (toolName !== "sessions_spawn") return;
        const sessionKey = event.sessionKey ?? (event as { ctx?: { sessionKey?: string } }).ctx?.sessionKey;
        if (!sessionKey) return;
        emitBotsChatDelegationFromToolResult(
          sessionKey,
          event.result,
          api.logger,
        );
      });
    }
  },
};

export default plugin;
