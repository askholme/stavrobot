import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createRunPluginToolTool, createManagePluginsTool, createRequestCodingTaskTool } from "./plugin-tools.js";
import fs from "fs/promises";
import path from "path";
import { TEMP_ATTACHMENTS_DIR } from "./temp-dir.js";

vi.mock("fs/promises", () => ({
  default: {
    rm: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));

function mockFetch(status: number, body: string): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    status,
    text: () => Promise.resolve(body),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createRunPluginToolTool", () => {
  const tool = createRunPluginToolTool();

  beforeEach(() => {
    vi.mocked(fs.rm).mockClear().mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockClear().mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockClear().mockResolvedValue(undefined);
  });

  it("formats a successful sync result with string output", async () => {
    mockFetch(200, JSON.stringify({ success: true, output: "hello world" }));
    const result = await tool.execute("call-1", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    expect(result.content[0].type).toBe("text");
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe('The run of tool "mytool" (plugin "myplugin") returned:\n```\nhello world\n```');
  });

  it("formats a successful sync result with object output as TOON", async () => {
    mockFetch(200, JSON.stringify({ success: true, output: { key: "value" } }));
    const result = await tool.execute("call-2", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe('The run of tool "mytool" (plugin "myplugin") returned:\n```\nkey: value\n```');
  });

  it("formats a failed sync result with error message", async () => {
    mockFetch(200, JSON.stringify({ success: false, error: "something went wrong" }));
    const result = await tool.execute("call-3", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe('The run of tool "mytool" (plugin "myplugin") failed:\n```\nsomething went wrong\n```');
  });

  it("uses 'Unknown error' when failure has no error field", async () => {
    mockFetch(200, JSON.stringify({ success: false }));
    const result = await tool.execute("call-4", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe('The run of tool "mytool" (plugin "myplugin") failed:\n```\nUnknown error\n```');
  });

  it("returns async message for 202 response", async () => {
    mockFetch(202, JSON.stringify({ status: "running" }));
    const result = await tool.execute("call-5", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe('Tool "mytool" (plugin "myplugin") is running asynchronously. The result will arrive when it completes.');
  });

  it("falls back to raw text when response is not valid JSON", async () => {
    mockFetch(200, "not json at all");
    const result = await tool.execute("call-6", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe("not json at all");
  });

  it("falls back to raw text when JSON does not have a 'success' boolean", async () => {
    mockFetch(200, JSON.stringify({ result: "something" }));
    const result = await tool.execute("call-7", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe(JSON.stringify({ result: "something" }));
  });

  it("clears the plugin files directory before making the HTTP request", async () => {
    mockFetch(200, JSON.stringify({ success: true, output: "done" }));
    await tool.execute("call-8", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    expect(vi.mocked(fs.rm)).toHaveBeenCalledWith(
      path.join(TEMP_ATTACHMENTS_DIR, "myplugin"),
      { recursive: true, force: true },
    );
  });

  it("saves transported files and appends 'Files produced' line to result", async () => {
    const fileData = Buffer.from("hello file").toString("base64");
    mockFetch(200, JSON.stringify({
      success: true,
      output: "done",
      files: [{ filename: "report.txt", data: fileData }],
    }));
    const result = await tool.execute("call-9", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    const expectedDir = path.join(TEMP_ATTACHMENTS_DIR, "myplugin");
    expect(vi.mocked(fs.mkdir)).toHaveBeenCalledWith(expectedDir, { recursive: true });
    expect(vi.mocked(fs.writeFile)).toHaveBeenCalledWith(
      path.join(expectedDir, "report.txt"),
      Buffer.from(fileData, "base64"),
    );
    expect(text).toContain(`\n\nFiles produced: ${expectedDir}/`);
  });

  it("does not append 'Files produced' when files array is empty", async () => {
    mockFetch(200, JSON.stringify({ success: true, output: "done", files: [] }));
    const result = await tool.execute("call-10", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).not.toContain("Files produced");
    expect(vi.mocked(fs.mkdir)).not.toHaveBeenCalled();
  });

  it("does not append 'Files produced' when files entries are invalid", async () => {
    mockFetch(200, JSON.stringify({ success: true, output: "done", files: [{ bad: "entry" }] }));
    const result = await tool.execute("call-11", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).not.toContain("Files produced");
    expect(vi.mocked(fs.mkdir)).not.toHaveBeenCalled();
  });

  it("does not append 'Files produced' when response has no files field", async () => {
    mockFetch(200, JSON.stringify({ success: true, output: "done" }));
    const result = await tool.execute("call-12", { plugin: "myplugin", tool: "mytool", parameters: "{}" });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).not.toContain("Files produced");
  });
});

describe("createManagePluginsTool", () => {
  describe("help action", () => {
    const tool = createManagePluginsTool({ coderEnabled: false });

    it("returns help text", async () => {
      const result = await tool.execute("call-1", { action: "help" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toContain("manage_plugins");
      expect(text).toContain("install");
      expect(text).toContain("create");
    });
  });

  describe("install action", () => {
    const tool = createManagePluginsTool({ coderEnabled: false });

    it("returns the message field from the response JSON", async () => {
      mockFetch(200, JSON.stringify({ name: "myplugin", message: "Plugin 'myplugin' installed successfully." }));
      const result = await tool.execute("call-1", { action: "install", url: "https://example.com/plugin.git" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Plugin 'myplugin' installed successfully.");
    });

    it("appends init_output when present", async () => {
      mockFetch(200, JSON.stringify({
        name: "myplugin",
        message: "Plugin 'myplugin' installed successfully.",
        init_output: "Installed dependencies.\n",
      }));
      const result = await tool.execute("call-2", { action: "install", url: "https://example.com/plugin.git" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Plugin 'myplugin' installed successfully.\n\nInit script output:\n```\nInstalled dependencies.\n\n```");
    });

    it("falls back to raw text when response is not valid JSON", async () => {
      mockFetch(200, "not json");
      const result = await tool.execute("call-3", { action: "install", url: "https://example.com/plugin.git" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("not json");
    });

    it("TOON-encodes the response when JSON has no message field", async () => {
      mockFetch(200, JSON.stringify({ name: "myplugin" }));
      const result = await tool.execute("call-4", { action: "install", url: "https://example.com/plugin.git" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("name: myplugin");
    });

    it("returns an error when url is missing", async () => {
      const result = await tool.execute("call-5", { action: "install" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Error: url is required for install.");
    });
  });

  describe("update action", () => {
    const tool = createManagePluginsTool({ coderEnabled: false });

    it("returns the message field from the response JSON", async () => {
      mockFetch(200, JSON.stringify({ name: "myplugin", message: "Plugin 'myplugin' updated successfully." }));
      const result = await tool.execute("call-1", { action: "update", name: "myplugin" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Plugin 'myplugin' updated successfully.");
    });

    it("appends init_output when present", async () => {
      mockFetch(200, JSON.stringify({
        name: "myplugin",
        message: "Plugin 'myplugin' updated successfully.",
        init_output: "Re-installed dependencies.\n",
      }));
      const result = await tool.execute("call-2", { action: "update", name: "myplugin" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Plugin 'myplugin' updated successfully.\n\nInit script output:\n```\nRe-installed dependencies.\n\n```");
    });

    it("returns an error when name is missing", async () => {
      const result = await tool.execute("call-3", { action: "update" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Error: name is required for update.");
    });
  });

  describe("create action", () => {
    it("calls POST /create with the correct body and returns the message field", async () => {
      const tool = createManagePluginsTool({ coderEnabled: true });
      mockFetch(200, JSON.stringify({ name: "myplugin", message: "Plugin 'myplugin' created." }));
      const result = await tool.execute("call-1", { action: "create", name: "myplugin", plugin_description: "A test plugin." });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Plugin 'myplugin' created.");
      const fetchMock = vi.mocked(globalThis.fetch);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://plugin-runner:3003/create",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "myplugin", description: "A test plugin." }),
        }),
      );
    });

    it("returns an error when coder is not enabled", async () => {
      const tool = createManagePluginsTool({ coderEnabled: false });
      const result = await tool.execute("call-2", { action: "create", name: "myplugin", plugin_description: "A test plugin." });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Error: the create action requires the coder to be configured.");
    });

    it("returns an error when name is missing", async () => {
      const tool = createManagePluginsTool({ coderEnabled: true });
      const result = await tool.execute("call-3", { action: "create", plugin_description: "A test plugin." });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Error: name is required for create.");
    });

    it("returns an error when plugin_description is missing", async () => {
      const tool = createManagePluginsTool({ coderEnabled: true });
      const result = await tool.execute("call-4", { action: "create", name: "myplugin" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Error: plugin_description is required for create.");
    });
  });

  describe("list action", () => {
    const tool = createManagePluginsTool({ coderEnabled: false });

    it("TOON-encodes the plugin list response", async () => {
      mockFetch(200, JSON.stringify([{ name: "plugin1" }, { name: "plugin2" }]));
      const result = await tool.execute("call-1", { action: "list" });
      const text = (result.content[0] as { type: string; text: string }).text;
      // TOON format uses column headers like {name} rather than JSON object syntax.
      expect(text).not.toContain('{"name"');
      expect(text).toContain("plugin1");
      expect(text).toContain("plugin2");
    });

    it("falls back to raw text when response is not valid JSON", async () => {
      mockFetch(200, "not json");
      const result = await tool.execute("call-2", { action: "list" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("not json");
    });
  });

  describe("show action", () => {
    const tool = createManagePluginsTool({ coderEnabled: false });

    it("TOON-encodes the plugin manifest response", async () => {
      mockFetch(200, JSON.stringify({ name: "myplugin", tools: ["tool1"] }));
      const result = await tool.execute("call-1", { action: "show", name: "myplugin" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).not.toContain("{");
      expect(text).toContain("myplugin");
    });

    it("returns an error when name is missing", async () => {
      const result = await tool.execute("call-2", { action: "show" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Error: name is required for show.");
    });
  });

  describe("remove action", () => {
    const tool = createManagePluginsTool({ coderEnabled: false });

    it("returns the message field from the response JSON", async () => {
      mockFetch(200, JSON.stringify({ message: "Plugin 'myplugin' removed." }));
      const result = await tool.execute("call-1", { action: "remove", name: "myplugin" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Plugin 'myplugin' removed.");
    });

    it("falls back to raw text when response is not valid JSON", async () => {
      mockFetch(200, "not json");
      const result = await tool.execute("call-2", { action: "remove", name: "myplugin" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("not json");
    });

    it("returns an error when name is missing", async () => {
      const result = await tool.execute("call-3", { action: "remove" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Error: name is required for remove.");
    });
  });

  describe("configure action", () => {
    const tool = createManagePluginsTool({ coderEnabled: false });

    it("returns the message field from the response JSON", async () => {
      mockFetch(200, JSON.stringify({ message: "Plugin 'myplugin' configured." }));
      const result = await tool.execute("call-1", { action: "configure", name: "myplugin", config: '{"key":"value"}' });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Plugin 'myplugin' configured.");
    });

    it("appends warnings when present and non-empty", async () => {
      mockFetch(200, JSON.stringify({ message: "Plugin 'myplugin' configured.", warnings: ["Unknown key: foo"] }));
      const result = await tool.execute("call-2", { action: "configure", name: "myplugin", config: '{"key":"value"}' });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Plugin 'myplugin' configured.\n\nWarnings:\nUnknown key: foo");
    });

    it("does not append warnings when warnings array is empty", async () => {
      mockFetch(200, JSON.stringify({ message: "Plugin 'myplugin' configured.", warnings: [] }));
      const result = await tool.execute("call-3", { action: "configure", name: "myplugin", config: '{"key":"value"}' });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Plugin 'myplugin' configured.");
    });

    it("falls back to raw text when response is not valid JSON", async () => {
      mockFetch(200, "not json");
      const result = await tool.execute("call-4", { action: "configure", name: "myplugin", config: '{"key":"value"}' });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("not json");
    });

    it("returns an error when name is missing", async () => {
      const result = await tool.execute("call-5", { action: "configure", config: '{"key":"value"}' });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Error: name is required for configure.");
    });

    it("returns an error when config is missing", async () => {
      const result = await tool.execute("call-6", { action: "configure", name: "myplugin" });
      const text = (result.content[0] as { type: string; text: string }).text;
      expect(text).toBe("Error: config is required for configure.");
    });
  });
});

describe("createRequestCodingTaskTool", () => {
  const tool = createRequestCodingTaskTool();

  it("returns an error when the plugin is not found (404)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      status: 404,
      text: () => Promise.resolve("Not found"),
    }));
    const result = await tool.execute("call-1", { plugin: "missing", message: "Add a tool." });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe("Plugin 'missing' not found. Create it first with manage_plugins (action: create).");
  });

  it("returns an error when the plugin is not editable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ name: "gitplugin", editable: false })),
    }));
    const result = await tool.execute("call-2", { plugin: "gitplugin", message: "Add a tool." });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toBe("Plugin 'gitplugin' is not editable. Only locally created plugins can be modified by the coding agent.");
  });

  it("submits the task to the coder when the plugin is editable", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ name: "myplugin", editable: true })),
      })
      .mockResolvedValueOnce({
        status: 202,
        text: () => Promise.resolve(""),
      }),
    );
    const result = await tool.execute("call-3", { plugin: "myplugin", message: "Add a hello tool." });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toMatch(/^Coding task .+ submitted for plugin 'myplugin'\. The coder agent will respond when done\.$/);
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://plugin-runner:3003/bundles/myplugin",
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://coder:3002/code",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"plugin":"myplugin"'),
      }),
    );
  });
});
