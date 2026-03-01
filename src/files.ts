import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { TEMP_ATTACHMENTS_DIR } from "./temp-dir.js";
import { log } from "./log.js";

const FILES_DIR = path.join(TEMP_ATTACHMENTS_DIR, "files");

const HELP_TEXT = `manage_files: manage files in a temporary directory (${FILES_DIR}).

Actions:
- write: write content to a file. Parameters: filename (required), content (required), encoding ("utf-8" default or "base64").
- read: read a file's content as utf-8 text. Parameters: filename (required).
- list: list all files in the directory. Returns absolute paths, one per line.
- delete: delete a file. Parameters: filename (required).
- help: show this help text.

Constraints:
- Flat namespace only. Filenames must not contain "/" or "\\" (no subdirectories).
- Files are ephemeral. They live in ${FILES_DIR} and may be deleted automatically when passed as attachmentPath to send_signal_message or send_telegram_message.
- To send a file as an attachment, pass its absolute path (returned by write or list) as the attachmentPath parameter to send_signal_message or send_telegram_message.
- No size limits are enforced.`;

function validateFilename(filename: string): string | null {
  if (filename.includes("/") || filename.includes("\\")) {
    return "Error: filename must not contain path separators ('/' or '\\\\').";
  }
  return null;
}

export function createManageFilesTool(): AgentTool {
  return {
    name: "manage_files",
    label: "Manage files",
    description: "Create and manage temporary files. Use the 'help' action for details.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("write"),
        Type.Literal("read"),
        Type.Literal("list"),
        Type.Literal("delete"),
        Type.Literal("help"),
      ], { description: "Action to perform: write, read, list, delete, or help." }),
      filename: Type.Optional(Type.String({ description: "Filename (no path separators). Required for write, read, and delete." })),
      content: Type.Optional(Type.String({ description: "File content. Required for write." })),
      encoding: Type.Optional(Type.String({ description: "Encoding for write: 'utf-8' (default) or 'base64'." })),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ result: string }>> => {
      const raw = params as {
        action: string;
        filename?: string;
        content?: string;
        encoding?: string;
      };

      const action = raw.action;

      if (action === "help") {
        return {
          content: [{ type: "text" as const, text: HELP_TEXT }],
          details: { result: HELP_TEXT },
        };
      }

      if (action === "list") {
        let filenames: string[];
        try {
          filenames = await fs.readdir(FILES_DIR);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            filenames = [];
          } else {
            throw error;
          }
        }
        const absolutePaths = filenames.map((name) => path.join(FILES_DIR, name));
        const result = absolutePaths.join("\n");
        log.debug(`[stavrobot] manage_files list: ${filenames.length} file(s)`);
        return {
          content: [{ type: "text" as const, text: result }],
          details: { result },
        };
      }

      if (action === "write") {
        if (raw.filename === undefined || raw.filename.trim() === "") {
          const errorMessage = "Error: filename is required for write.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { result: errorMessage },
          };
        }
        const filenameError = validateFilename(raw.filename);
        if (filenameError !== null) {
          return {
            content: [{ type: "text" as const, text: filenameError }],
            details: { result: filenameError },
          };
        }
        if (raw.content === undefined) {
          const errorMessage = "Error: content is required for write.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { result: errorMessage },
          };
        }

        await fs.mkdir(FILES_DIR, { recursive: true });
        const filePath = path.join(FILES_DIR, raw.filename);

        const encoding = raw.encoding ?? "utf-8";
        if (encoding === "base64") {
          const buffer = Buffer.from(raw.content, "base64");
          await fs.writeFile(filePath, buffer);
        } else {
          await fs.writeFile(filePath, raw.content, "utf-8");
        }

        log.debug(`[stavrobot] manage_files write: ${filePath}`);
        return {
          content: [{ type: "text" as const, text: filePath }],
          details: { result: filePath },
        };
      }

      if (action === "read") {
        if (raw.filename === undefined || raw.filename.trim() === "") {
          const errorMessage = "Error: filename is required for read.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { result: errorMessage },
          };
        }
        const filenameError = validateFilename(raw.filename);
        if (filenameError !== null) {
          return {
            content: [{ type: "text" as const, text: filenameError }],
            details: { result: filenameError },
          };
        }

        const filePath = path.join(FILES_DIR, raw.filename);
        const fileContent = await fs.readFile(filePath, "utf-8");
        log.debug(`[stavrobot] manage_files read: ${filePath} (${fileContent.length} chars)`);
        return {
          content: [{ type: "text" as const, text: fileContent }],
          details: { result: fileContent },
        };
      }

      if (action === "delete") {
        if (raw.filename === undefined || raw.filename.trim() === "") {
          const errorMessage = "Error: filename is required for delete.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { result: errorMessage },
          };
        }
        const filenameError = validateFilename(raw.filename);
        if (filenameError !== null) {
          return {
            content: [{ type: "text" as const, text: filenameError }],
            details: { result: filenameError },
          };
        }

        const filePath = path.join(FILES_DIR, raw.filename);
        await fs.unlink(filePath);
        const successMessage = `File deleted: ${filePath}`;
        log.debug(`[stavrobot] manage_files delete: ${filePath}`);
        return {
          content: [{ type: "text" as const, text: successMessage }],
          details: { result: successMessage },
        };
      }

      const errorMessage = `Error: unknown action '${action}'. Valid actions: write, read, list, delete, help.`;
      return {
        content: [{ type: "text" as const, text: errorMessage }],
        details: { result: errorMessage },
      };
    },
  };
}
