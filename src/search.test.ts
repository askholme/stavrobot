import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Pool, QueryResult } from "pg";

vi.mock("./embeddings.js", () => ({
  fetchEmbeddings: vi.fn(),
  extractText: vi.fn().mockImplementation((content: unknown) => {
    if (typeof content === "string") return content;
    return "";
  }),
}));
vi.mock("./database.js", () => ({
  getMainAgentId: vi.fn().mockReturnValue(1),
  COMPACTION_THRESHOLD: 40,
}));
vi.mock("./toon.js", () => ({
  encodeToToon: vi.fn().mockReturnValue(""),
}));
vi.mock("./log.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { fetchEmbeddings } from "./embeddings.js";
import { runSearch } from "./search.js";
import type { EmbeddingsConfig } from "./config.js";

const fetchEmbeddingsMock = vi.mocked(fetchEmbeddings);

beforeEach(() => {
  vi.clearAllMocks();
});

function makeMockPool(queryImpl: (text: string, values?: unknown[]) => Promise<QueryResult>): Pool {
  return {
    query: vi.fn().mockImplementation(queryImpl),
  } as unknown as Pool;
}

const isColumnDiscoveryQuery = (text: string): boolean => text.includes("information_schema");
const isCutoffQuery = (text: string): boolean =>
  text.includes("FROM messages") && text.includes("OFFSET") && !text.includes("m.role");
const isFullTextMessageQuery = (text: string): boolean =>
  text.includes("FROM messages") && text.includes("m.role") && !text.includes("JOIN message_embeddings");
const isSemanticMessageQuery = (text: string): boolean =>
  text.includes("JOIN message_embeddings");

// Returns an empty result for all queries (no matches, no messages).
function emptyPool(): Pool {
  return makeMockPool(() =>
    Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult),
  );
}

// Returns a pool where the cutoff query returns a row (simulating >= threshold messages),
// but all other message queries return empty.
function poolWithCutoff(cutoffId: number): Pool {
  return makeMockPool((text) => {
    if (isCutoffQuery(text)) {
      return Promise.resolve({ rows: [{ id: cutoffId }], rowCount: 1 } as unknown as QueryResult);
    }
    return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
  });
}

const embeddingsConfig: EmbeddingsConfig = { apiKey: "test-key" };

describe("runSearch — queryEmbedding in SearchResults", () => {
  it("populates queryEmbedding when embeddings are configured and the API call succeeds", async () => {
    const embedding = [0.1, 0.2, 0.3];
    fetchEmbeddingsMock.mockResolvedValueOnce([embedding]);

    const pool = poolWithCutoff(100);
    const results = await runSearch(pool, "hello world", 5, 1, embeddingsConfig);

    expect(results.queryEmbedding).toEqual(embedding);
  });

  it("leaves queryEmbedding undefined when embeddings are not configured", async () => {
    const pool = poolWithCutoff(100);
    const results = await runSearch(pool, "hello world", 5, 1, undefined);

    expect(results.queryEmbedding).toBeUndefined();
  });

  it("leaves queryEmbedding undefined when the embedding API call fails", async () => {
    fetchEmbeddingsMock.mockRejectedValueOnce(new Error("API error"));

    const pool = poolWithCutoff(100);
    const results = await runSearch(pool, "hello world", 5, 1, embeddingsConfig);

    expect(results.queryEmbedding).toBeUndefined();
  });

  it("still returns search results even when the embedding API call fails", async () => {
    fetchEmbeddingsMock.mockRejectedValueOnce(new Error("API error"));

    const pool = poolWithCutoff(100);
    const results = await runSearch(pool, "hello world", 5, 1, embeddingsConfig);

    expect(results.tableResults).toEqual([]);
    expect(results.messages).toEqual([]);
  });
});

describe("runSearch — recent-message exclusion", () => {
  it("returns no message hits when fewer than threshold messages exist (full-text path)", async () => {
    // Cutoff query returns empty → fewer than threshold messages.
    const pool = emptyPool();
    const results = await runSearch(pool, "hello", 5, 1, undefined);

    expect(results.messages).toEqual([]);
  });

  it("returns no message hits when fewer than threshold messages exist (semantic path)", async () => {
    const embedding = [0.1, 0.2, 0.3];
    fetchEmbeddingsMock.mockResolvedValueOnce([embedding]);

    const pool = emptyPool();
    const results = await runSearch(pool, "hello", 5, 1, embeddingsConfig);

    expect(results.messages).toEqual([]);
    // fetchEmbeddings must not be called when we return early.
    expect(fetchEmbeddingsMock).not.toHaveBeenCalled();
  });

  it("returns table results even when fewer than threshold messages exist", async () => {
    // The table search runs before the cutoff check, so table results are still returned.
    let tableQueryCount = 0;
    const pool = makeMockPool((text) => {
      if (isColumnDiscoveryQuery(text)) {
        return Promise.resolve({
          rows: [{ table_name: "notes", column_name: "body", has_created_at: false }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      if (!isCutoffQuery(text) && !isFullTextMessageQuery(text) && !isSemanticMessageQuery(text)) {
        tableQueryCount++;
        if (tableQueryCount === 1) {
          return Promise.resolve({
            rows: [{ id: 1, body: "match" }],
            rowCount: 1,
          } as unknown as QueryResult);
        }
      }
      // Cutoff query returns empty → fewer than threshold.
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });

    const results = await runSearch(pool, "match", 5, 1, undefined);

    expect(results.tableResults).toHaveLength(1);
    expect(results.messages).toEqual([]);
  });

  it("returns message hits from the older portion when above threshold (full-text path)", async () => {
    const oldMessage = {
      id: 5,
      role: "user",
      content: { content: "old message" },
      created_at: new Date("2024-01-01"),
    };

    const pool = makeMockPool((text) => {
      if (isCutoffQuery(text)) {
        // cutoffId = 50, so messages with id < 50 are searchable.
        return Promise.resolve({ rows: [{ id: 50 }], rowCount: 1 } as unknown as QueryResult);
      }
      if (isFullTextMessageQuery(text)) {
        return Promise.resolve({ rows: [oldMessage], rowCount: 1 } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });

    const results = await runSearch(pool, "old message", 5, 1, undefined);

    expect(results.messages).toHaveLength(1);
    expect(results.messages[0].id).toBe(5);
  });

  it("passes cutoffId to the full-text query so recent messages are excluded", async () => {
    let fullTextQueryValues: unknown[] | undefined;

    const pool = makeMockPool((text, values) => {
      if (isCutoffQuery(text)) {
        return Promise.resolve({ rows: [{ id: 75 }], rowCount: 1 } as unknown as QueryResult);
      }
      if (isFullTextMessageQuery(text)) {
        fullTextQueryValues = values;
        return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });

    await runSearch(pool, "test", 5, 1, undefined);

    // The fourth parameter ($4) must be the cutoffId (75).
    expect(fullTextQueryValues).toBeDefined();
    expect((fullTextQueryValues as unknown[])[3]).toBe(75);
  });

  it("excludes recent messages from results.messages on the full-text path", async () => {
    // cutoffId = 100: ids 10 and 50 are old (< 100), ids 110 and 200 are recent (>= 100).
    const oldMessage1 = { id: 10, role: "user", content: { content: "old one" }, created_at: new Date("2024-01-01") };
    const oldMessage2 = { id: 50, role: "assistant", content: { content: "old two" }, created_at: new Date("2024-01-02") };
    const recentMessage1 = { id: 110, role: "user", content: { content: "recent one" }, created_at: new Date("2024-06-01") };
    const recentMessage2 = { id: 200, role: "assistant", content: { content: "recent two" }, created_at: new Date("2024-06-02") };

    const pool = makeMockPool((text) => {
      if (isCutoffQuery(text)) {
        return Promise.resolve({ rows: [{ id: 100 }], rowCount: 1 } as unknown as QueryResult);
      }
      if (isFullTextMessageQuery(text)) {
        // The SQL must contain the cutoff clause; if it is absent the test fails here.
        expect(text).toContain("m.id < $4");
        // Return only the old messages, simulating what the SQL WHERE m.id < $4 clause produces.
        return Promise.resolve({ rows: [oldMessage1, oldMessage2], rowCount: 2 } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });

    const results = await runSearch(pool, "test", 5, 1, undefined);

    const resultIds = results.messages.map((m) => m.id);
    // Old messages must be present.
    expect(resultIds).toContain(10);
    expect(resultIds).toContain(50);
    // Recent messages must be absent.
    expect(resultIds).not.toContain(110);
    expect(resultIds).not.toContain(200);
  });

  it("passes cutoffId to the semantic query so recent messages are excluded", async () => {
    const embedding = [0.1, 0.2, 0.3];
    fetchEmbeddingsMock.mockResolvedValueOnce([embedding]);

    let semanticQueryValues: unknown[] | undefined;

    const pool = makeMockPool((text, values) => {
      if (isCutoffQuery(text)) {
        return Promise.resolve({ rows: [{ id: 75 }], rowCount: 1 } as unknown as QueryResult);
      }
      if (isSemanticMessageQuery(text)) {
        semanticQueryValues = values;
        return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });

    await runSearch(pool, "test", 5, 1, embeddingsConfig);

    // The fourth parameter ($4) must be the cutoffId (75).
    expect(semanticQueryValues).toBeDefined();
    expect((semanticQueryValues as unknown[])[3]).toBe(75);
  });

  it("excludes recent messages from results.messages on the semantic path", async () => {
    const embedding = [0.1, 0.2, 0.3];
    fetchEmbeddingsMock.mockResolvedValueOnce([embedding]);

    // cutoffId = 100: ids 20 and 60 are old (< 100), ids 120 and 180 are recent (>= 100).
    const oldMessage1 = { id: 20, role: "user", content: { content: "old sem one" }, created_at: new Date("2024-01-01") };
    const oldMessage2 = { id: 60, role: "assistant", content: { content: "old sem two" }, created_at: new Date("2024-01-02") };
    const recentMessage1 = { id: 120, role: "user", content: { content: "recent sem one" }, created_at: new Date("2024-06-01") };
    const recentMessage2 = { id: 180, role: "assistant", content: { content: "recent sem two" }, created_at: new Date("2024-06-02") };

    const pool = makeMockPool((text) => {
      if (isCutoffQuery(text)) {
        return Promise.resolve({ rows: [{ id: 100 }], rowCount: 1 } as unknown as QueryResult);
      }
      if (isSemanticMessageQuery(text)) {
        // The SQL must contain the cutoff clause; if it is absent the test fails here.
        expect(text).toContain("m.id < $4");
        // Return only the old messages, simulating what the SQL WHERE m.id < $4 clause produces.
        return Promise.resolve({ rows: [oldMessage1, oldMessage2], rowCount: 2 } as unknown as QueryResult);
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });

    const results = await runSearch(pool, "test", 5, 1, embeddingsConfig);

    const resultIds = results.messages.map((m) => m.id);
    // Old messages must be present.
    expect(resultIds).toContain(20);
    expect(resultIds).toContain(60);
    // Recent messages must be absent.
    expect(resultIds).not.toContain(120);
    expect(resultIds).not.toContain(180);
  });
});

describe("runSearch — table result row capping", () => {
  // Builds a pool that returns one fake table with `rowCount` rows.
  function poolWithTableRows(rowCount: number): Pool {
    let tableQueryCount = 0;
    return makeMockPool((text) => {
      if (isColumnDiscoveryQuery(text)) {
        // Return one fake table with one text column.
        return Promise.resolve({
          rows: [{ table_name: "notes", column_name: "body", has_created_at: false }],
          rowCount: 1,
        } as unknown as QueryResult);
      }
      if (isCutoffQuery(text)) {
        return Promise.resolve({ rows: [{ id: 100 }], rowCount: 1 } as unknown as QueryResult);
      }
      if (!isFullTextMessageQuery(text) && !isSemanticMessageQuery(text)) {
        tableQueryCount++;
        if (tableQueryCount === 1) {
          const rows = Array.from({ length: rowCount }, (_, i) => ({ id: i + 1, body: `row${i + 1}` }));
          return Promise.resolve({ rows, rowCount } as unknown as QueryResult);
        }
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });
  }

  // Builds a pool that returns rows for two different tables.
  function poolWithTwoTableResults(firstCount: number, secondCount: number): Pool {
    let tableQueryCount = 0;
    return makeMockPool((text) => {
      if (isColumnDiscoveryQuery(text)) {
        return Promise.resolve({
          rows: [
            { table_name: "notes", column_name: "body", has_created_at: false },
            { table_name: "tasks", column_name: "title", has_created_at: false },
          ],
          rowCount: 2,
        } as unknown as QueryResult);
      }
      if (isCutoffQuery(text)) {
        return Promise.resolve({ rows: [{ id: 100 }], rowCount: 1 } as unknown as QueryResult);
      }
      if (!isFullTextMessageQuery(text) && !isSemanticMessageQuery(text)) {
        tableQueryCount++;
        if (tableQueryCount === 1) {
          const rows = Array.from({ length: firstCount }, (_, i) => ({ id: i + 1, body: `a${i}` }));
          return Promise.resolve({ rows, rowCount: firstCount } as unknown as QueryResult);
        }
        if (tableQueryCount === 2) {
          const rows = Array.from({ length: secondCount }, (_, i) => ({ id: i + 1, title: `b${i}` }));
          return Promise.resolve({ rows, rowCount: secondCount } as unknown as QueryResult);
        }
      }
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult);
    });
  }

  it("returns all rows when total is within the 5-row cap", async () => {
    const pool = poolWithTableRows(3);
    const results = await runSearch(pool, "test", 10, 1, undefined);

    const totalRows = results.tableResults.reduce((sum, t) => sum + t.rows.length, 0);
    expect(totalRows).toBe(3);
  });

  it("caps total table rows at 5 when a single table returns more", async () => {
    const pool = poolWithTableRows(10);
    const results = await runSearch(pool, "test", 10, 1, undefined);

    const totalRows = results.tableResults.reduce((sum, t) => sum + t.rows.length, 0);
    expect(totalRows).toBe(5);
  });

  it("caps total rows at 5 across two tables", async () => {
    // First table: 4 rows, second table: 4 rows — total should be capped at 5.
    const pool = poolWithTwoTableResults(4, 4);
    const results = await runSearch(pool, "test", 10, 1, undefined);

    const totalRows = results.tableResults.reduce((sum, t) => sum + t.rows.length, 0);
    expect(totalRows).toBe(5);
    // First table gets 4 rows, second gets only 1.
    expect(results.tableResults[0].rows).toHaveLength(4);
    expect(results.tableResults[1].rows).toHaveLength(1);
  });

  it("excludes tables entirely when the cap is already reached by earlier tables", async () => {
    // First table: 5 rows, second table: 3 rows — second table should be excluded.
    const pool = poolWithTwoTableResults(5, 3);
    const results = await runSearch(pool, "test", 10, 1, undefined);

    expect(results.tableResults).toHaveLength(1);
    expect(results.tableResults[0].rows).toHaveLength(5);
  });
});
