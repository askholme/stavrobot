import { describe, it, expect, vi } from "vitest";
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

function makeMockPool(queryImpl: (text: string, values?: unknown[]) => Promise<QueryResult>): Pool {
  return {
    query: vi.fn().mockImplementation(queryImpl),
  } as unknown as Pool;
}

// Returns an empty result for all queries (no matches).
function emptyPool(): Pool {
  return makeMockPool(() =>
    Promise.resolve({ rows: [], rowCount: 0 } as unknown as QueryResult),
  );
}

const embeddingsConfig: EmbeddingsConfig = { apiKey: "test-key" };

describe("runSearch — queryEmbedding in SearchResults", () => {
  it("populates queryEmbedding when embeddings are configured and the API call succeeds", async () => {
    const embedding = [0.1, 0.2, 0.3];
    fetchEmbeddingsMock.mockResolvedValueOnce([embedding]);

    const pool = emptyPool();
    const results = await runSearch(pool, "hello world", 5, 1, embeddingsConfig);

    expect(results.queryEmbedding).toEqual(embedding);
  });

  it("leaves queryEmbedding undefined when embeddings are not configured", async () => {
    const pool = emptyPool();
    const results = await runSearch(pool, "hello world", 5, 1, undefined);

    expect(results.queryEmbedding).toBeUndefined();
  });

  it("leaves queryEmbedding undefined when the embedding API call fails", async () => {
    fetchEmbeddingsMock.mockRejectedValueOnce(new Error("API error"));

    const pool = emptyPool();
    const results = await runSearch(pool, "hello world", 5, 1, embeddingsConfig);

    expect(results.queryEmbedding).toBeUndefined();
  });

  it("still returns search results even when the embedding API call fails", async () => {
    fetchEmbeddingsMock.mockRejectedValueOnce(new Error("API error"));

    const pool = emptyPool();
    const results = await runSearch(pool, "hello world", 5, 1, embeddingsConfig);

    expect(results.tableResults).toEqual([]);
    expect(results.messages).toEqual([]);
  });
});

describe("runSearch — table result row capping", () => {
  // The column discovery query targets information_schema.columns. All other
  // non-messages queries are per-table full-text searches.
  const isColumnDiscoveryQuery = (text: string): boolean => text.includes("information_schema");
  const isMessagesQuery = (text: string): boolean => text.includes("FROM messages");

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
      if (!isMessagesQuery(text)) {
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
      if (!isMessagesQuery(text)) {
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
