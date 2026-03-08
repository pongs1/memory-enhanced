import { AssociativeScanner } from "../stream/associative-scanner.js";

// A global registry for active scanners per session
const scanners = new Map<string, AssociativeScanner>();

export function registerStreamWrapper(api: any, pluginConfig: any) {
    // We assume the user's OpenClaw modification exposes a "wrap_stream_fn" hook
    // that allows us to wrap the raw provider stream function.
    api.on("wrap_stream_fn", async (event: any, ctx: any) => {
        const sid = ctx?.sessionId || "default";
        const workspace = ctx.workspaceDir || (pluginConfig as any)?.workspace || process.cwd();

        // Ensure a scanner exists for this session
        if (!scanners.has(sid)) {
            scanners.set(sid, new AssociativeScanner(workspace));
        }
        const scanner = scanners.get(sid)!;

        const originalStreamFn = event.streamFn;

        // Return the wrapped stream function
        event.streamFn = async function* (model: any, context: any, options: any) {
            const stream = originalStreamFn(model, context, options);

            for await (const chunk of stream) {
                // Yield the chunk normally
                yield chunk;

                // Only intercept deltas
                if (chunk.type === "text_delta" || chunk.type === "thinking_delta") {
                    const triggerFile = scanner.processChunk(chunk.delta);

                    if (triggerFile) {
                        // A memory node breached the activation threshold!
                        // We abort the underlying stream by triggering the abort controller if present
                        if (options?.signal && options.signal.abort) {
                            // This is a soft-abort conceptually, but we assume the underlying
                            // runner will catch it.
                            // Actually, since we control the generator, we can just yield a steer and break!

                            const memoryContent = scanner.getMemoryContent(triggerFile);
                            const interruptPrompt = `\n\n[SUBCONSCIOUS RECALL TRIGGERED] Your recent thoughts strongly activated a latent memory regarding "${triggerFile}".\n\nMemory contents:\n${memoryContent}\n\nPlease immediately integrate this into your current thought process and continue.\n`;

                            // Yield a steer event to force the assistant to see it
                            yield {
                                type: "steer",
                                content: interruptPrompt
                            };

                            // End the stream prematurely
                            break;
                        }
                    }
                }
            }
        };
    });

    // Hook into llm_input to catch the user prompt BEFORE generation starts
    api.on("llm_input", async (event: any, ctx: any) => {
        const sid = ctx?.sessionId || "default";
        const workspace = ctx.workspaceDir || (pluginConfig as any)?.workspace || process.cwd();

        if (!scanners.has(sid)) {
            scanners.set(sid, new AssociativeScanner(workspace));
        }
        const scanner = scanners.get(sid)!;

        // Extract the latest user message
        const messages = event.historyMessages || [];
        const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");

        let promptText = event.prompt || "";
        if (lastUserMsg) {
            if (typeof lastUserMsg.content === "string") {
                promptText += " " + lastUserMsg.content;
            } else if (Array.isArray(lastUserMsg.content)) {
                promptText += " " + lastUserMsg.content.map((c: any) => c.text || "").join(" ");
            }
        }

        if (promptText) {
            // Pre-excite the network with the user's stimulus!
            scanner.preExcite(promptText);
        }
    });
}
