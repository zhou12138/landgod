/**
 * openclaw-plugin-landgod
 *
 * LandGod execution network plugin for OpenClaw.
 * Registers tools that call the LandGod Gateway HTTP API.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";

const DEFAULT_GATEWAY = "http://localhost:8081";

async function gatewayFetch(
  gatewayUrl: string,
  path: string,
  options?: RequestInit
): Promise<unknown> {
  const url = `${gatewayUrl.replace(/\/+$/, "")}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  return res.json();
}

export default definePluginEntry({
  id: "landgod",
  name: "LandGod",
  description:
    "Enterprise execution network — dispatch tools through LandGod Gateway / MCPHub",

  register(api) {
    const gw = () =>
      (api.getConfig?.()?.gatewayUrl as string) || DEFAULT_GATEWAY;

    // ─── landgod_clients ───────────────────────────────────
    api.registerTool({
      name: "landgod_clients",
      description:
        "List all connected LandGod workers with their labels, resources (CPU/memory/load), and tools.",
      parameters: Type.Object({}),
      async execute() {
        const data = await gatewayFetch(gw(), "/clients");
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      },
    });

    // ─── landgod_tools ─────────────────────────────────────
    api.registerTool({
      name: "landgod_tools",
      description:
        "List registered tools per worker (including external MCP server tools).",
      parameters: Type.Object({}),
      async execute() {
        const data = await gatewayFetch(gw(), "/tools");
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      },
    });

    // ─── landgod_execute ───────────────────────────────────
    api.registerTool({
      name: "landgod_execute",
      description:
        "Execute a shell command on a worker execution node. Specify target by clientName or labels. Returns stdout, stderr, and exit code.",
      parameters: Type.Object({
        command: Type.String({ description: "Shell command to execute" }),
        clientName: Type.Optional(
          Type.String({ description: "Target worker name" })
        ),
        labels: Type.Optional(
          Type.Record(Type.String(), Type.Union([Type.String(), Type.Boolean(), Type.Number()]), {
            description:
              'Route by capability labels, e.g. {"gpu":true,"region":"us"}',
          })
        ),
        timeout: Type.Optional(
          Type.Number({
            default: 30000,
            description: "Timeout in milliseconds",
          })
        ),
        async: Type.Optional(
          Type.Boolean({
            default: false,
            description: "Return immediately with taskId (for long-running commands)",
          })
        ),
        queue: Type.Optional(
          Type.Boolean({
            default: false,
            description: "Queue for offline workers (auto-executes when worker reconnects)",
          })
        ),
      }),
      async execute(_id, params) {
        const queryParams = [];
        if (params.async) queryParams.push("async=true");
        if (params.queue) queryParams.push("queue=true");
        const qs = queryParams.length ? `?${queryParams.join("&")}` : "";

        const body: Record<string, unknown> = {
          tool_name: "shell_execute",
          arguments: { command: params.command },
        };
        if (params.clientName) body.clientName = params.clientName;
        if (params.labels) body.labels = params.labels;
        if (params.timeout) body.timeout = params.timeout;

        const data = await gatewayFetch(gw(), `/tool_call${qs}`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      },
    });

    // ─── landgod_batch ─────────────────────────────────────
    api.registerTool({
      name: "landgod_batch",
      description:
        "Execute commands on multiple workers in parallel. Each call runs independently.",
      parameters: Type.Object({
        calls: Type.Array(
          Type.Object({
            clientName: Type.Optional(Type.String()),
            labels: Type.Optional(
              Type.Record(Type.String(), Type.Union([Type.String(), Type.Boolean(), Type.Number()]))
            ),
            command: Type.String({ description: "Shell command" }),
            timeout: Type.Optional(Type.Number()),
          }),
          { description: "Array of commands to execute in parallel" }
        ),
      }),
      async execute(_id, params) {
        const body = {
          calls: params.calls.map((c) => ({
            clientName: c.clientName,
            labels: c.labels,
            tool_name: "shell_execute",
            arguments: { command: c.command },
            timeout: c.timeout,
          })),
        };
        const data = await gatewayFetch(gw(), "/batch_tool_call", {
          method: "POST",
          body: JSON.stringify(body),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      },
    });

    // ─── landgod_task ──────────────────────────────────────
    api.registerTool({
      name: "landgod_task",
      description:
        "Check the status and result of an async or queued task by taskId.",
      parameters: Type.Object({
        taskId: Type.String({ description: "Task ID from async/queue execution" }),
      }),
      async execute(_id, params) {
        const data = await gatewayFetch(gw(), `/tasks/${params.taskId}`);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      },
    });

    // ─── landgod_tasks ─────────────────────────────────────
    api.registerTool({
      name: "landgod_tasks",
      description: "List all async and queued tasks.",
      parameters: Type.Object({
        status: Type.Optional(
          Type.String({
            description: "Filter by status: pending, completed, failed, queued",
          })
        ),
      }),
      async execute(_id, params) {
        const qs = params.status ? `?status=${params.status}` : "";
        const data = await gatewayFetch(gw(), `/tasks${qs}`);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      },
    });

    // ─── landgod_screenshot ────────────────────────────────
    api.registerTool(
      {
        name: "landgod_screenshot",
        description:
          "Take a screenshot of a remote Windows/GUI worker's desktop. Returns base64 PNG image. Requires worker with computer-use MCP server and active RDP session.",
        parameters: Type.Object({
          clientName: Type.Optional(Type.String({ description: "Target worker" })),
          labels: Type.Optional(
            Type.Record(Type.String(), Type.Union([Type.String(), Type.Boolean()]), {
              description: 'e.g. {"gui":true}',
            })
          ),
          maxWidth: Type.Optional(
            Type.Number({ default: 1024, description: "Max image width" })
          ),
        }),
        async execute(_id, params) {
          const body: Record<string, unknown> = {
            tool_name: "computer_screenshot",
            arguments: { max_width: params.maxWidth || 1024 },
          };
          if (params.clientName) body.clientName = params.clientName;
          if (params.labels) body.labels = params.labels;

          const data = await gatewayFetch(gw(), "/tool_call", {
            method: "POST",
            body: JSON.stringify(body),
          });
          return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          };
        },
      },
      { optional: true }
    );

    // ─── landgod_click ─────────────────────────────────────
    api.registerTool(
      {
        name: "landgod_click",
        description:
          "Click at specific coordinates on a remote desktop. Take a screenshot first to find coordinates.",
        parameters: Type.Object({
          clientName: Type.Optional(Type.String()),
          x: Type.Number({ description: "X coordinate" }),
          y: Type.Number({ description: "Y coordinate" }),
          button: Type.Optional(
            Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")], {
              default: "left",
            })
          ),
          clicks: Type.Optional(Type.Number({ default: 1, description: "1=single, 2=double" })),
        }),
        async execute(_id, params) {
          const body: Record<string, unknown> = {
            tool_name: "computer_click",
            arguments: { x: params.x, y: params.y, button: params.button, clicks: params.clicks },
          };
          if (params.clientName) body.clientName = params.clientName;

          const data = await gatewayFetch(gw(), "/tool_call", {
            method: "POST",
            body: JSON.stringify(body),
          });
          return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          };
        },
      },
      { optional: true }
    );

    // ─── landgod_type ──────────────────────────────────────
    api.registerTool(
      {
        name: "landgod_type",
        description:
          'Type text, press a key, or use keyboard shortcuts on a remote desktop. Examples: {"text":"hello"}, {"key":"enter"}, {"hotkey":["ctrl","c"]}',
        parameters: Type.Object({
          clientName: Type.Optional(Type.String()),
          text: Type.Optional(Type.String({ description: "Text to type" })),
          key: Type.Optional(
            Type.String({ description: "Single key: enter, tab, escape, backspace, f1-f12, etc." })
          ),
          hotkey: Type.Optional(
            Type.Array(Type.String(), {
              description: 'Key combo: ["ctrl","c"], ["alt","f4"], ["ctrl","shift","escape"]',
            })
          ),
        }),
        async execute(_id, params) {
          const args: Record<string, unknown> = {};
          if (params.text) args.text = params.text;
          if (params.key) args.key = params.key;
          if (params.hotkey) args.hotkey = params.hotkey;

          const body: Record<string, unknown> = {
            tool_name: "computer_type",
            arguments: args,
          };
          if (params.clientName) body.clientName = params.clientName;

          const data = await gatewayFetch(gw(), "/tool_call", {
            method: "POST",
            body: JSON.stringify(body),
          });
          return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          };
        },
      },
      { optional: true }
    );

    // ─── landgod_scroll ────────────────────────────────────
    api.registerTool(
      {
        name: "landgod_scroll",
        description: "Scroll on a remote desktop. Positive=up, negative=down.",
        parameters: Type.Object({
          clientName: Type.Optional(Type.String()),
          amount: Type.Number({ default: -3, description: "Scroll amount (+up, -down)" }),
          x: Type.Optional(Type.Number({ description: "X position to scroll at" })),
          y: Type.Optional(Type.Number({ description: "Y position to scroll at" })),
        }),
        async execute(_id, params) {
          const body: Record<string, unknown> = {
            tool_name: "computer_scroll",
            arguments: { amount: params.amount, x: params.x, y: params.y },
          };
          if (params.clientName) body.clientName = params.clientName;

          const data = await gatewayFetch(gw(), "/tool_call", {
            method: "POST",
            body: JSON.stringify(body),
          });
          return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          };
        },
      },
      { optional: true }
    );


    // ─── landgod_tool_call (generic) ───────────────────────
    api.registerTool({
      name: "landgod_tool_call",
      description:
        "Call ANY tool on a worker execution node — shell_execute, file_read, browser_*, computer_*, pptx_*, shiproom_*, or any custom MCP server tool. Use landgod_tools to discover available tools first.",
      parameters: Type.Object({
        clientName: Type.Optional(Type.String({ description: "Target worker name" })),
        labels: Type.Optional(
          Type.Record(Type.String(), Type.Union([Type.String(), Type.Boolean(), Type.Number()]))
        ),
        tool_name: Type.String({
          description: "Tool name (e.g. shell_execute, file_read, computer_screenshot, pptx_open, shiproom_fetch_loop)",
        }),
        arguments: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), {
            description: "Tool arguments as key-value pairs",
          })
        ),
        timeout: Type.Optional(Type.Number({ default: 30000 })),
        async: Type.Optional(Type.Boolean({ default: false })),
        queue: Type.Optional(Type.Boolean({ default: false })),
      }),
      async execute(_id, params) {
        const queryParams: string[] = [];
        if (params.async) queryParams.push("async=true");
        if (params.queue) queryParams.push("queue=true");
        const qs = queryParams.length ? "?" + queryParams.join("\&") : "";

        const body: Record<string, unknown> = {
          tool_name: params.tool_name,
          arguments: params.arguments || {},
        };
        if (params.clientName) body.clientName = params.clientName;
        if (params.labels) body.labels = params.labels;
        if (params.timeout) body.timeout = params.timeout;

        const data = await gatewayFetch(gw(), `/tool_call${qs}`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      },
    });

    // ─── landgod_audit ─────────────────────────────────────
    api.registerTool({
      name: "landgod_audit",
      description: "View centralized audit logs from workers.",
      parameters: Type.Object({
        clientName: Type.Optional(Type.String({ description: "Filter by worker" })),
        limit: Type.Optional(Type.Number({ default: 20 })),
      }),
      async execute(_id, params) {
        const qs = new URLSearchParams();
        if (params.clientName) qs.set("clientName", params.clientName);
        if (params.limit) qs.set("limit", String(params.limit));
        const query = qs.toString() ? `?${qs}` : "";

        const data = await gatewayFetch(gw(), `/audit${query}`);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      },
    });
  },
});
