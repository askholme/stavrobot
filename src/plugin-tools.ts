import fs from "fs/promises";
import path from "path";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { encodeToToon } from "./toon.js";
import { TEMP_ATTACHMENTS_DIR } from "./temp-dir.js";
import { log } from "./log.js";

const PLUGIN_RUNNER_BASE_URL = "http://plugin-runner:3003";
const CLAUDE_CODE_BASE_URL = "http://coder:3002";

interface BundleManifest {
  editable?: boolean;
  [key: string]: unknown;
}

interface PluginRunResult {
  success: boolean;
  output?: unknown;
  error?: string;
}

function isPluginRunResult(value: unknown): value is PluginRunResult {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj["success"] === "boolean";
}

// Formats any plugin-runner management response for the agent. Responses with a
// "message" field (install, update, remove, configure, create) are extracted and
// optionally augmented with init_output and warnings. Responses without a "message"
// field (list, show) are TOON-encoded. Falls back to raw text if parsing or encoding
// fails, because message delivery matters more than formatting.
function formatPluginRunnerResponse(responseText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText) as unknown;
  } catch {
    return responseText;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return responseText;
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj["message"] === "string") {
    let result = obj["message"];

    if (typeof obj["init_output"] === "string") {
      result += `\n\nInit script output:\n\`\`\`\n${obj["init_output"]}\n\`\`\``;
    }

    if (Array.isArray(obj["warnings"]) && obj["warnings"].length > 0) {
      const warnings = (obj["warnings"] as unknown[])
        .filter((w): w is string => typeof w === "string")
        .join("\n");
      if (warnings.length > 0) {
        result += `\n\nWarnings:\n${warnings}`;
      }
    }

    return result;
  }

  try {
    return encodeToToon(parsed);
  } catch {
    return responseText;
  }
}

function formatRunPluginToolResult(pluginName: string, toolName: string, responseText: string, statusCode: number): string {
  if (statusCode === 202) {
    return `Tool "${toolName}" (plugin "${pluginName}") is running asynchronously. The result will arrive when it completes.`;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText) as unknown;
  } catch {
    return responseText;
  }

  if (!isPluginRunResult(parsed)) {
    return responseText;
  }

  if (parsed.success) {
    const output = typeof parsed.output === "string" ? parsed.output : encodeToToon(parsed.output);
    return `The run of tool "${toolName}" (plugin "${pluginName}") returned:\n\`\`\`\n${output}\n\`\`\``;
  } else {
    const error = parsed.error ?? "Unknown error";
    return `The run of tool "${toolName}" (plugin "${pluginName}") failed:\n\`\`\`\n${error}\n\`\`\``;
  }
}

const MANAGE_PLUGINS_HELP_TEXT = `manage_plugins: install, update, remove, configure, list, show, or create plugins.

Actions:
- install: install a plugin from a git URL. Parameters: url (required).
- update: update an installed plugin to the latest version from its git repository. Parameters: name (required).
- remove: remove an installed plugin. Parameters: name (required).
- configure: set configuration values for a plugin. The config keys must match what the plugin's manifest declares. Parameters: name (required), config (required, JSON string).
- list: list all installed plugins. No additional parameters.
- show: show all tools in a plugin, including their names, descriptions, and parameter schemas. Parameters: name (required).
- create: create a new empty editable plugin. Parameters: name (required), plugin_description (required). Only available when the coder is configured.
- help: show this help text.`;

export function createManagePluginsTool(options: { coderEnabled: boolean }): AgentTool {
  return {
    name: "manage_plugins",
    label: "Manage plugins",
    description: "Install, update, remove, configure, list, show, or create plugins. Use the 'help' action for details.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("install"),
        Type.Literal("update"),
        Type.Literal("remove"),
        Type.Literal("configure"),
        Type.Literal("list"),
        Type.Literal("show"),
        Type.Literal("create"),
        Type.Literal("help"),
      ], { description: "Action to perform: install, update, remove, configure, list, show, create, or help." }),
      name: Type.Optional(Type.String({ description: "The plugin name. Required for update, remove, configure, show, and create." })),
      url: Type.Optional(Type.String({ description: "The git repository URL to clone. Required for install." })),
      config: Type.Optional(Type.String({ description: "JSON string of configuration values to set. Required for configure." })),
      plugin_description: Type.Optional(Type.String({ description: "A short description of what the plugin does. Required for create." })),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const raw = params as {
        action: string;
        name?: string;
        url?: string;
        config?: string;
        plugin_description?: string;
      };

      const action = raw.action;

      if (action === "help") {
        return {
          content: [{ type: "text" as const, text: MANAGE_PLUGINS_HELP_TEXT }],
          details: { result: MANAGE_PLUGINS_HELP_TEXT },
        };
      }

      if (action === "install") {
        if (raw.url === undefined || raw.url.trim() === "") {
          const result = "Error: url is required for install.";
          return {
            content: [{ type: "text" as const, text: result }],
            details: { result },
          };
        }
        const url = raw.url;
        const response = await fetch(`${PLUGIN_RUNNER_BASE_URL}/install`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
        const responseText = await response.text();
        const result = formatPluginRunnerResponse(responseText);
        return {
          content: [{ type: "text" as const, text: result }],
          details: { result },
        };
      }

      if (action === "update") {
        if (raw.name === undefined || raw.name.trim() === "") {
          const result = "Error: name is required for update.";
          return {
            content: [{ type: "text" as const, text: result }],
            details: { result },
          };
        }
        const name = raw.name;
        const response = await fetch(`${PLUGIN_RUNNER_BASE_URL}/update`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const responseText = await response.text();
        const result = formatPluginRunnerResponse(responseText);
        return {
          content: [{ type: "text" as const, text: result }],
          details: { result },
        };
      }

      if (action === "remove") {
        if (raw.name === undefined || raw.name.trim() === "") {
          const result = "Error: name is required for remove.";
          return {
            content: [{ type: "text" as const, text: result }],
            details: { result },
          };
        }
        const name = raw.name;
        const response = await fetch(`${PLUGIN_RUNNER_BASE_URL}/remove`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const responseText = await response.text();
        const result = formatPluginRunnerResponse(responseText);
        return {
          content: [{ type: "text" as const, text: result }],
          details: { result },
        };
      }

      if (action === "configure") {
        if (raw.name === undefined || raw.name.trim() === "") {
          const result = "Error: name is required for configure.";
          return {
            content: [{ type: "text" as const, text: result }],
            details: { result },
          };
        }
        if (raw.config === undefined || raw.config.trim() === "") {
          const result = "Error: config is required for configure.";
          return {
            content: [{ type: "text" as const, text: result }],
            details: { result },
          };
        }
        const name = raw.name;
        const config = raw.config;
        let parsedConfig: unknown;
        try {
          parsedConfig = JSON.parse(config);
        } catch {
          const result = "Error: config is not valid JSON.";
          return {
            content: [{ type: "text" as const, text: result }],
            details: { result },
          };
        }
        const response = await fetch(`${PLUGIN_RUNNER_BASE_URL}/configure`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, config: parsedConfig }),
        });
        const responseText = await response.text();
        const result = formatPluginRunnerResponse(responseText);
        return {
          content: [{ type: "text" as const, text: result }],
          details: { result },
        };
      }

      if (action === "list") {
        const response = await fetch(`${PLUGIN_RUNNER_BASE_URL}/bundles`);
        const responseText = await response.text();
        const result = formatPluginRunnerResponse(responseText);
        return {
          content: [{ type: "text" as const, text: result }],
          details: { result },
        };
      }

      if (action === "show") {
        if (raw.name === undefined || raw.name.trim() === "") {
          const result = "Error: name is required for show.";
          return {
            content: [{ type: "text" as const, text: result }],
            details: { result },
          };
        }
        const name = raw.name;
        const response = await fetch(`${PLUGIN_RUNNER_BASE_URL}/bundles/${name}`);
        if (response.status === 404) {
          const result = `Plugin '${name}' not found.`;
          return {
            content: [{ type: "text" as const, text: result }],
            details: { result },
          };
        }
        const responseText = await response.text();
        const result = formatPluginRunnerResponse(responseText);
        return {
          content: [{ type: "text" as const, text: result }],
          details: { result },
        };
      }

      if (action === "create") {
        if (!options.coderEnabled) {
          const result = "Error: the create action requires the coder to be configured.";
          return {
            content: [{ type: "text" as const, text: result }],
            details: { result },
          };
        }
        if (raw.name === undefined || raw.name.trim() === "") {
          const result = "Error: name is required for create.";
          return {
            content: [{ type: "text" as const, text: result }],
            details: { result },
          };
        }
        if (raw.plugin_description === undefined || raw.plugin_description.trim() === "") {
          const result = "Error: plugin_description is required for create.";
          return {
            content: [{ type: "text" as const, text: result }],
            details: { result },
          };
        }
        const name = raw.name;
        const description = raw.plugin_description;
        const response = await fetch(`${PLUGIN_RUNNER_BASE_URL}/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, description }),
        });
        const responseText = await response.text();
        const result = formatPluginRunnerResponse(responseText);
        return {
          content: [{ type: "text" as const, text: result }],
          details: { result },
        };
      }

      const result = `Error: unknown action '${action}'. Valid actions: install, update, remove, configure, list, show, create, help.`;
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}

export function createRunPluginToolTool(): AgentTool {
  return {
    name: "run_plugin_tool",
    label: "Run plugin tool",
    description: "Run a tool from an installed plugin with the given parameters. The parameters must match the tool's schema as shown by manage_plugins (action: show).",
    parameters: Type.Object({
      plugin: Type.String({ description: "The plugin name." }),
      tool: Type.String({ description: "The tool name." }),
      parameters: Type.String({ description: "JSON string of the parameters to pass to the tool." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { plugin, tool, parameters } = params as { plugin: string; tool: string; parameters: string };
      const parsedParameters = JSON.parse(parameters) as unknown;

      const pluginFilesDir = path.join(TEMP_ATTACHMENTS_DIR, plugin);
      // Clear stale files from previous runs.
      await fs.rm(pluginFilesDir, { recursive: true, force: true });

      const response = await fetch(`${PLUGIN_RUNNER_BASE_URL}/bundles/${plugin}/tools/${tool}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsedParameters),
      });
      const responseText = await response.text();
      let result = formatRunPluginToolResult(plugin, tool, responseText, response.status);

      let filesDir: string | undefined;
      try {
        const parsed = JSON.parse(responseText) as unknown;
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "files" in parsed &&
          Array.isArray((parsed as Record<string, unknown>).files)
        ) {
          const files = (parsed as Record<string, unknown>).files as unknown[];
          const validFiles = files.filter(
            (f): f is { filename: string; data: string } =>
              typeof f === "object" &&
              f !== null &&
              typeof (f as Record<string, unknown>).filename === "string" &&
              typeof (f as Record<string, unknown>).data === "string"
          );
          if (validFiles.length > 0) {
            await fs.mkdir(pluginFilesDir, { recursive: true });
            for (const file of validFiles) {
              const filePath = path.join(pluginFilesDir, file.filename);
              await fs.writeFile(filePath, Buffer.from(file.data, "base64"));
            }
            filesDir = pluginFilesDir;
            log.debug(`[stavrobot] run_plugin_tool: saved ${validFiles.length} file(s) to ${pluginFilesDir}`);
          }
        }
      } catch {
        // If JSON parsing fails here, formatRunPluginToolResult already handled it.
      }

      if (filesDir !== undefined) {
        result += `\n\nFiles produced: ${filesDir}/`;
      }

      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}

function isBundleManifest(value: unknown): value is BundleManifest {
  return typeof value === "object" && value !== null;
}

export function createRequestCodingTaskTool(): AgentTool {
  return {
    name: "request_coding_task",
    label: "Request coding task",
    description: "Send a coding task to the coding agent to create or modify a specific plugin. The plugin must be editable (locally created, not installed from a git repository). This is asynchronous — the result will arrive later as a message from the coder agent. Describe what you want clearly and completely.",
    parameters: Type.Object({
      plugin: Type.String({ description: "The name of the plugin to create or modify. Must be an editable (locally created) plugin." }),
      message: Type.String({ description: "A detailed description of what to create or modify in the plugin." }),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<{ result: string }>> => {
      const { plugin, message } = params as { plugin: string; message: string };

      const bundleResponse = await fetch(`${PLUGIN_RUNNER_BASE_URL}/bundles/${plugin}`);
      if (bundleResponse.status === 404) {
        const result = `Plugin '${plugin}' not found. Create it first with manage_plugins (action: create).`;
        return {
          content: [{ type: "text" as const, text: result }],
          details: { result },
        };
      }

      const bundleText = await bundleResponse.text();
      let manifest: unknown;
      try {
        manifest = JSON.parse(bundleText) as unknown;
      } catch {
        const result = `Failed to parse plugin manifest for '${plugin}'.`;
        return {
          content: [{ type: "text" as const, text: result }],
          details: { result },
        };
      }

      if (!isBundleManifest(manifest) || manifest.editable !== true) {
        const result = `Plugin '${plugin}' is not editable. Only locally created plugins can be modified by the coding agent.`;
        return {
          content: [{ type: "text" as const, text: result }],
          details: { result },
        };
      }

      const taskId = crypto.randomUUID();
      log.debug("[stavrobot] request_coding_task submitting: taskId", taskId, "plugin:", plugin, "message:", message);
      await fetch(`${CLAUDE_CODE_BASE_URL}/code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, plugin, message }),
      });
      const result = `Coding task ${taskId} submitted for plugin '${plugin}'. The coder agent will respond when done.`;
      return {
        content: [{ type: "text" as const, text: result }],
        details: { result },
      };
    },
  };
}
