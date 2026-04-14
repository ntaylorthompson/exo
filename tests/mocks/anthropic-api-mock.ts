/**
 * Mock for Claude CLI executor — intercepts CLI invocations at the module level.
 *
 * Usage in tests:
 *   import { mockAnthropicResponse, resetAnthropicMock, getCliMockExecutor } from "../mocks/anthropic-api-mock";
 *   import { _setCliExecutorForTesting } from "../../src/main/services/anthropic-service";
 *
 *   // Set up a canned response
 *   mockAnthropicResponse({ text: '{"needs_reply": true}' });
 *   _setCliExecutorForTesting(getCliMockExecutor());
 *
 *   // Now any service that calls createMessage() will get this response.
 */

export interface MockMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: Array<{ type: "text"; text: string }>;
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence";
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

// State for the mock
let responseQueue: Array<MockMessageResponse | Error> = [];
let defaultResponse: MockMessageResponse | null = null;
let capturedRequests: Array<{
  model: string;
  messages: unknown[];
  system?: unknown;
  max_tokens?: number;
  tools?: unknown[];
}> = [];

// Also capture CLI args for inspection
let capturedCliArgs: Array<{ args: string[]; stdin: string }> = [];

function buildResponse(
  text: string,
  model: string = "claude-sonnet-4-20250514",
): MockMessageResponse {
  return {
    id: `msg_mock_${Date.now()}`,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 0,
    },
  };
}

/**
 * Set a canned text response. All subsequent calls return this.
 */
export function mockAnthropicResponse(opts: { text: string; model?: string }): void {
  defaultResponse = buildResponse(opts.text, opts.model);
}

/**
 * Queue multiple responses (consumed in order). Falls back to defaultResponse when exhausted.
 */
export function queueAnthropicResponses(responses: Array<{ text: string; model?: string }>): void {
  for (const r of responses) {
    responseQueue.push(buildResponse(r.text, r.model));
  }
}

/**
 * Queue an error to be thrown on the next call.
 */
export function mockAnthropicError(error: Error): void {
  responseQueue.push(error);
}

/**
 * Get captured requests. Each entry reconstructs the params from CLI args.
 */
export function getCapturedRequests(): typeof capturedRequests {
  return [...capturedRequests];
}

/**
 * Get raw captured CLI args for detailed inspection.
 */
export function getCapturedCliArgs(): typeof capturedCliArgs {
  return [...capturedCliArgs];
}

/**
 * Reset all mock state.
 */
export function resetAnthropicMock(): void {
  responseQueue = [];
  defaultResponse = null;
  capturedRequests = [];
  capturedCliArgs = [];
}

/**
 * Get a CLI executor function that returns canned responses.
 * Pass this to _setCliExecutorForTesting().
 */
export function getCliMockExecutor(): (
  args: string[],
  stdin: string,
  timeoutMs?: number,
) => Promise<{ stdout: string; stderr: string }> {
  return async (args: string[], stdin: string) => {
    capturedCliArgs.push({ args, stdin });

    // Reconstruct a request-like object from CLI args for getCapturedRequests()
    const modelIdx = args.indexOf("--model");
    const model = modelIdx >= 0 ? args[modelIdx + 1] : "unknown";
    const sysIdx = args.indexOf("--system-prompt");
    const system = sysIdx >= 0 ? args[sysIdx + 1] : undefined;

    capturedRequests.push({
      model,
      messages: [{ role: "user", content: stdin }],
      system: system ? [{ type: "text", text: system }] : undefined,
    });

    // Dequeue first, fall back to default
    let response: MockMessageResponse;
    if (responseQueue.length > 0) {
      const next = responseQueue.shift()!;
      if (next instanceof Error) throw next;
      response = next;
    } else if (defaultResponse) {
      response = defaultResponse;
    } else {
      throw new Error(
        "[MockCliExecutor] No response configured. Call mockAnthropicResponse() before invoking services.",
      );
    }

    // Return CLI JSON format
    const cliResponse = {
      type: "result",
      subtype: "success",
      result: response.content[0].text,
      model: response.model,
      total_cost_usd: 0.001,
      duration_ms: 100,
      usage: response.usage,
    };

    return { stdout: JSON.stringify(cliResponse), stderr: "" };
  };
}

/**
 * @deprecated Use getCliMockExecutor() with _setCliExecutorForTesting() instead.
 * Kept for backward compatibility during migration.
 */
export class MockAnthropic {
  messages = {
    create: async (params: {
      model: string;
      messages: unknown[];
      system?: unknown;
      max_tokens?: number;
      tools?: unknown[];
    }): Promise<MockMessageResponse> => {
      capturedRequests.push(params);

      if (responseQueue.length > 0) {
        const next = responseQueue.shift()!;
        if (next instanceof Error) throw next;
        return next;
      }

      if (defaultResponse) {
        return defaultResponse;
      }

      throw new Error(
        "[MockAnthropic] No response configured. Call mockAnthropicResponse() or queueAnthropicResponses() before invoking services.",
      );
    },
  };
}
