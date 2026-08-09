import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

type RealtimeOutcome = {
  clientEvents: string[];
  errors: string[];
  observedEvents: string[];
  tools: Array<{ itemId: string; callId: string; name: string; args: unknown }>;
  connected: boolean;
};

function createFixtureSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForFixtureEvent(promise: Promise<void>, label: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function captureRealtimeOutcome(
  terminalEvent: Record<string, unknown>,
  options: { queueFollowup?: boolean } = {},
): Promise<RealtimeOutcome> {
  const outcome: RealtimeOutcome = {
    clientEvents: [],
    errors: [],
    observedEvents: [],
    tools: [],
    connected: false,
  };
  const responseCreated = createFixtureSignal();
  const terminalProcessed = createFixtureSignal();
  const followupCreated = createFixtureSignal();
  const server = createServer();
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("message", (message) => {
        const event = JSON.parse(Buffer.from(message as Buffer).toString("utf8")) as {
          type?: string;
        };
        if (!event.type) {
          return;
        }
        outcome.clientEvents.push(event.type);
        if (event.type === "session.update" && outcome.clientEvents.length === 1) {
          ws.send(JSON.stringify({ type: "session.updated" }));
        }
        if (event.type === "response.create") {
          followupCreated.resolve();
        }
      });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = (server.address() as AddressInfo).port;
  const bridge = buildOpenAIRealtimeVoiceProvider().createBridge({
    providerConfig: { apiKey: "fixture-value", azureEndpoint: `http://127.0.0.1:${port}` },
    onAudio() {},
    onClearAudio() {},
    onError: (error) => {
      outcome.errors.push(error.message);
      outcome.observedEvents.push(`error:${error.message}`);
    },
    onToolCall: (tool) => outcome.tools.push(tool),
    onEvent: (event) => {
      outcome.observedEvents.push(`${event.direction}:${event.type}`);
      if (event.direction !== "server") {
        return;
      }
      if (event.type === "response.created") {
        responseCreated.resolve();
      }
      if (event.type === terminalEvent.type) {
        queueMicrotask(() => terminalProcessed.resolve());
      }
    },
  });

  try {
    await bridge.connect();
    const socket = [...sockets][0];
    if (!socket) {
      throw new Error("expected a connected realtime fixture socket");
    }
    socket.send(JSON.stringify({ type: "response.created", response: { id: "response_1" } }));
    await waitForFixtureEvent(responseCreated.promise, "response.created");

    if (options.queueFollowup) {
      bridge.sendUserMessage?.("Continue after the terminal response.");
    }
    socket.send(JSON.stringify(terminalEvent));
    await waitForFixtureEvent(terminalProcessed.promise, "terminal response");
    if (options.queueFollowup) {
      await waitForFixtureEvent(followupCreated.promise, "queued follow-up response.create");
    }
    outcome.connected = bridge.isConnected();
    return outcome;
  } finally {
    bridge.close();
    for (const socket of sockets) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

const completedTool = {
  id: "item_tool",
  type: "function_call",
  status: "completed",
  call_id: "call_tool",
  name: "lookup_weather",
  arguments: JSON.stringify({ city: "Paris" }),
};

describe("OpenAI realtime terminal response ownership", () => {
  it.each([
    {
      name: "surfaces a failed response's provider error code",
      response: {
        status: "failed",
        status_details: { error: { type: "server_error", code: "rate_limit_exceeded" } },
        output: [completedTool],
      },
      errors: ["OpenAI realtime voice response failed: rate_limit_exceeded"],
    },
    {
      name: "surfaces a failed response's provider error message",
      response: {
        status: "failed",
        status_details: {
          error: { code: "server_error", message: "upstream model unavailable" },
        },
        output: [completedTool],
      },
      errors: ["OpenAI realtime voice response failed: upstream model unavailable"],
    },
    {
      name: "surfaces failed responses even when provider details are absent",
      response: { status: "failed", output: [completedTool] },
      errors: ["OpenAI realtime voice response failed"],
    },
    {
      name: "surfaces the authoritative maximum-output-token limit",
      response: {
        status: "incomplete",
        status_details: { type: "incomplete", reason: "max_output_tokens" },
        output: [completedTool],
      },
      errors: ["OpenAI realtime voice response incomplete: max_output_tokens"],
    },
    {
      name: "surfaces the authoritative content-filter cutoff",
      response: {
        status: "incomplete",
        status_details: { type: "incomplete", reason: "content_filter" },
        output: [completedTool],
      },
      errors: ["OpenAI realtime voice response incomplete: content_filter"],
    },
    {
      name: "does not report an intentionally client-cancelled response",
      response: {
        status: "cancelled",
        status_details: { type: "cancelled", reason: "client_cancelled" },
        output: [completedTool],
      },
      errors: [],
    },
    {
      name: "does not report a normal VAD interruption",
      response: {
        status: "cancelled",
        status_details: { type: "cancelled", reason: "turn_detected" },
        output: [completedTool],
      },
      errors: [],
    },
    {
      name: "does not report a successfully completed response",
      response: { status: "completed", output: [] },
      errors: [],
    },
  ])("$name over a reusable WebSocket", async ({ response, errors }) => {
    const outcome = await captureRealtimeOutcome(
      { type: "response.done", response: { id: "response_1", ...response } },
      { queueFollowup: true },
    );

    expect(outcome.errors).toEqual(errors);
    expect(outcome.tools).toEqual([]);
    expect(outcome.clientEvents.filter((event) => event === "response.create")).toHaveLength(1);
    expect(outcome.connected).toBe(true);

    if (errors.length > 0) {
      expect(outcome.observedEvents.indexOf("server:response.done")).toBeLessThan(
        outcome.observedEvents.indexOf(`error:${errors[0]}`),
      );
      expect(outcome.observedEvents.indexOf(`error:${errors[0]}`)).toBeLessThan(
        outcome.observedEvents.indexOf("client:response.create"),
      );
    }
  });

  it("preserves successful terminal tool execution on the same real transport", async () => {
    const outcome = await captureRealtimeOutcome({
      type: "response.done",
      response: { id: "response_1", status: "completed", output: [completedTool] },
    });

    expect(outcome.errors).toEqual([]);
    expect(outcome.tools).toEqual([
      {
        itemId: "item_tool",
        callId: "call_tool",
        name: "lookup_weather",
        args: { city: "Paris" },
      },
    ]);
    expect(outcome.connected).toBe(true);
  });
});
