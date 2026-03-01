import pg from "pg";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { upsertPage, deletePage } from "./database.js";

const MANAGE_PAGES_HELP_TEXT = `manage_pages: create, update, or delete web pages.

Actions:
- upsert: create or update a page. Parameters: path (required), mimetype (required for new pages), content (required for new pages), is_public (optional), queries (optional).
- delete: delete a page by path. Parameters: path (required).
- help: show this help text.

Pages are served at /pages/<path>.

On an existing page, omit any field to keep its current value. On a new page, content and mimetype are required.

The queries parameter maps query names to SQL strings (SELECT/WITH only). Use $param:name placeholders for parameters the client supplies via query string. Page JS fetches data via GET /api/pages/<path>/queries/<name>?param1=value1. The response is a JSON array of row objects. For private pages the endpoint requires authentication (the browser is already authenticated by the page load); for public pages no authentication is needed.

Security constraint: NEVER set is_public to true unless the user has *explicitly* and *unambiguously* said they want THIS SPECIFIC PAGE publicly accessible. Default to false. Only set true if the user says something clearly intentional such as "make this page public". When in doubt, keep it private.`;

export function createManagePagesTool(pool: pg.Pool): AgentTool {
  return {
    name: "manage_pages",
    label: "Manage pages",
    description: "Create, update, or delete dynamic web pages. Use the 'help' action for details.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("upsert"),
        Type.Literal("delete"),
        Type.Literal("help"),
      ], { description: "Action to perform: upsert, delete, or help." }),
      path: Type.Optional(Type.String({ description: "Page path, no leading or trailing slashes. Required for upsert and delete." })),
      mimetype: Type.Optional(Type.String({ description: "MIME type, e.g. text/html, text/css. Required when creating a new page." })),
      content: Type.Optional(Type.String({ description: "The page content as a string. Required when creating a new page." })),
      is_public: Type.Optional(Type.Boolean({ description: "Whether the page is publicly accessible without authentication. Defaults to false for new pages." })),
      queries: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Maps query names to SQL strings. Use $param:name placeholders for parameters the client supplies via query string." })),
    }),
    execute: async (
      toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<{ message: string }>> => {
      const raw = params as {
        action: string;
        path?: string;
        mimetype?: string;
        content?: string;
        is_public?: boolean;
        queries?: Record<string, string>;
      };

      const action = raw.action;

      if (action === "help") {
        return {
          content: [{ type: "text" as const, text: MANAGE_PAGES_HELP_TEXT }],
          details: { message: MANAGE_PAGES_HELP_TEXT },
        };
      }

      if (action === "upsert") {
        if (raw.path === undefined || raw.path.trim() === "") {
          const errorMessage = "Error: path is required for upsert.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }

        const message = await upsertPage(pool, raw.path, raw.mimetype, raw.content, raw.is_public, raw.queries);

        return {
          content: [{ type: "text" as const, text: message }],
          details: { message },
        };
      }

      if (action === "delete") {
        if (raw.path === undefined || raw.path.trim() === "") {
          const errorMessage = "Error: path is required for delete.";
          return {
            content: [{ type: "text" as const, text: errorMessage }],
            details: { message: errorMessage },
          };
        }

        const deleted = await deletePage(pool, raw.path);
        const message = deleted ? `Page deleted: ${raw.path}` : `Page not found: ${raw.path}`;

        return {
          content: [{ type: "text" as const, text: message }],
          details: { message },
        };
      }

      const errorMessage = `Error: unknown action '${action}'. Valid actions: upsert, delete, help.`;
      return {
        content: [{ type: "text" as const, text: errorMessage }],
        details: { message: errorMessage },
      };
    },
  };
}
