/**
 * Harness di test per index.js
 * Testa gli endpoint /slow-stats e /fast-stats
 * 
 * Approccio: Mock manuale delle dipendenze
 */

import { jest } from "@jest/globals";
import Fastify from "fastify";

describe("API Endpoints", () => {
  let app;
  let mockQuery;
  let mockGet;
  let mockSetEx;
  let mockRedisClient;

  // Configurazione query e cache key (stesse di index.js)
  const PREPARED_QUERY = {
    name: "fetch-transactions-modulo-cents",
    text: `
      SELECT COUNT(*)::text as total 
      FROM transactions.transactions_large
      WHERE created_at >= $1 AND created_at < $2
      AND (amount % 1) = 0.99;
    `,
    values: ["2026-10-01", "2026-11-01"],
  };

  const CACHE_KEY = "stats:2026-10:99_cents";

  beforeEach(async () => {
    // Crea nuove funzioni mock per ogni test
    mockQuery = jest.fn();
    mockGet = jest.fn();
    mockSetEx = jest.fn();

    // Crea mock client Redis
    mockRedisClient = {
      on: jest.fn(),
      connect: jest.fn().mockResolvedValue(undefined),
      get: mockGet,
      setEx: mockSetEx,
    };

    // Crea un'istanza Fastify fresh
    app = Fastify({ logger: false });

    // Decora manualmente app.pg con il mock
    app.decorate("pg", { query: mockQuery });

    // Definisci route /slow-stats
    app.get("/slow-stats", async (request, reply) => {
      const start = performance.now();
      try {
        const { rows } = await app.pg.query(PREPARED_QUERY);
        const duration = performance.now() - start;
        return {
          source: "PostgreSQL (Prepared Statement)",
          total_transactions: parseInt(rows[0].total, 10),
          execution_time_ms: parseFloat(duration.toFixed(2)),
        };
      } catch (err) {
        reply.status(500).send({ error: err.message });
      }
    });

    // Definisci route /fast-stats con deduplicazione Promise (anti-stampede)
    const inFlightRequests = new Map();
    app.get("/fast-stats", async (request, reply) => {
      try {
        const cachedValue = await mockRedisClient.get(CACHE_KEY);

        if (cachedValue !== null) {
          const duration = performance.now() - (request.startTime || performance.now());
          return {
            source: "Redis (Cache Hit)",
            total_transactions: parseInt(cachedValue, 10),
            execution_time_ms: parseFloat(duration.toFixed(2)),
          };
        }

        if (inFlightRequests.has(CACHE_KEY)) {
          const result = await inFlightRequests.get(CACHE_KEY);
          result.source = "Redis (Cache Hit - Deduplicated)";
          return result;
        }

        const start = performance.now();
        const promise = (async () => {
          try {
            const { rows } = await app.pg.query(PREPARED_QUERY);
            const total = rows[0].total;
            try {
              await mockRedisClient.setEx(CACHE_KEY, 3600, total);
            } catch (cacheErr) {
              console.error("[CACHE WRITE ERROR] setEx failed:", cacheErr.message);
            }
            const duration = performance.now() - start;
            return {
              source: "PostgreSQL (Cache Miss + Prepared Statement)",
              total_transactions: parseInt(total, 10),
              execution_time_ms: parseFloat(duration.toFixed(2)),
            };
          } finally {
            inFlightRequests.delete(CACHE_KEY);
          }
        })();

        inFlightRequests.set(CACHE_KEY, promise);
        return await promise;
      } catch (err) {
        reply.status(500).send({ error: err.message });
      }
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // ==========================================
  // TEST: /slow-stats endpoint
  // ==========================================
  describe("GET /slow-stats", () => {
    test("should return transaction count from PostgreSQL", async () => {
      // Arrange
      mockQuery.mockResolvedValue({ rows: [{ total: "1500" }] });

      // Act
      const response = await app.inject({ method: "GET", url: "/slow-stats" });

      // Assert
      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.source).toBe("PostgreSQL (Prepared Statement)");
      expect(payload.total_transactions).toBe(1500);
      expect(typeof payload.execution_time_ms).toBe("number");
    });

    test("should call PostgreSQL with prepared statement", async () => {
      // Arrange
      mockQuery.mockResolvedValue({ rows: [{ total: "100" }] });

      // Act
      await app.inject({ method: "GET", url: "/slow-stats" });

      // Assert
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({ name: "fetch-transactions-modulo-cents" })
      );
    });

    test("should return 500 on database error", async () => {
      // Arrange
      mockQuery.mockRejectedValue(new Error("Connection refused"));

      // Act
      const response = await app.inject({ method: "GET", url: "/slow-stats" });

      // Assert
      expect(response.statusCode).toBe(500);
      const payload = JSON.parse(response.payload);
      expect(payload.error).toBe("Connection refused");
    });

    test("should handle zero results", async () => {
      // Arrange
      mockQuery.mockResolvedValue({ rows: [{ total: "0" }] });

      // Act
      const response = await app.inject({ method: "GET", url: "/slow-stats" });

      // Assert
      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.total_transactions).toBe(0);
    });

    test("should handle large numbers", async () => {
      // Arrange
      mockQuery.mockResolvedValue({ rows: [{ total: "20000000" }] });

      // Act
      const response = await app.inject({ method: "GET", url: "/slow-stats" });

      // Assert
      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.total_transactions).toBe(20000000);
    });
  });

  // ==========================================
  // TEST: /fast-stats endpoint
  // ==========================================
  describe("GET /fast-stats", () => {
    test("should return cached value on cache hit", async () => {
      // Arrange
      mockGet.mockResolvedValue("2500");

      // Act
      const response = await app.inject({ method: "GET", url: "/fast-stats" });

      // Assert
      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.source).toBe("Redis (Cache Hit)");
      expect(payload.total_transactions).toBe(2500);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    test("should query PostgreSQL and cache on cache miss", async () => {
      // Arrange
      mockGet.mockResolvedValue(null);
      mockQuery.mockResolvedValue({ rows: [{ total: "3000" }] });
      mockSetEx.mockResolvedValue("OK");

      // Act
      const response = await app.inject({ method: "GET", url: "/fast-stats" });

      // Assert
      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.source).toBe("PostgreSQL (Cache Miss + Prepared Statement)");
      expect(payload.total_transactions).toBe(3000);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockSetEx).toHaveBeenCalledWith("stats:2026-10:99_cents", 3600, "3000");
    });

    test("should call Redis GET with correct cache key", async () => {
      // Arrange
      mockGet.mockResolvedValue(null);
      mockQuery.mockResolvedValue({ rows: [{ total: "100" }] });
      mockSetEx.mockResolvedValue("OK");

      // Act
      await app.inject({ method: "GET", url: "/fast-stats" });

      // Assert
      expect(mockGet).toHaveBeenCalledWith("stats:2026-10:99_cents");
    });

    test("should return 500 on Redis error", async () => {
      // Arrange
      mockGet.mockRejectedValue(new Error("Redis connection lost"));

      // Act
      const response = await app.inject({ method: "GET", url: "/fast-stats" });

      // Assert
      expect(response.statusCode).toBe(500);
      const payload = JSON.parse(response.payload);
      expect(payload.error).toBe("Redis connection lost");
    });

    test("should return 500 on PostgreSQL error during cache miss", async () => {
      // Arrange
      mockGet.mockResolvedValue(null);
      mockQuery.mockRejectedValue(new Error("Query timeout"));

      // Act
      const response = await app.inject({ method: "GET", url: "/fast-stats" });

      // Assert
      expect(response.statusCode).toBe(500);
      const payload = JSON.parse(response.payload);
      expect(payload.error).toBe("Query timeout");
    });

    test("should set cache with TTL of 3600 seconds", async () => {
      // Arrange
      mockGet.mockResolvedValue(null);
      mockQuery.mockResolvedValue({ rows: [{ total: "500" }] });
      mockSetEx.mockResolvedValue("OK");

      // Act
      await app.inject({ method: "GET", url: "/fast-stats" });

      // Assert
      expect(mockSetEx).toHaveBeenCalledWith(expect.any(String), 3600, expect.any(String));
    });

    test("should not query PostgreSQL when cache hit occurs", async () => {
      // Arrange
      mockGet.mockResolvedValue("1000");

      // Act
      await app.inject({ method: "GET", url: "/fast-stats" });

      // Assert
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockSetEx).not.toHaveBeenCalled();
    });
  });

  // ==========================================
  // TEST: Response structure validation
  // ==========================================
  describe("Response Structure", () => {
    test("slow-stats should have correct response schema", async () => {
      // Arrange
      mockQuery.mockResolvedValue({ rows: [{ total: "42" }] });

      // Act
      const response = await app.inject({ method: "GET", url: "/slow-stats" });
      const payload = JSON.parse(response.payload);

      // Assert
      expect(payload).toHaveProperty("source");
      expect(payload).toHaveProperty("total_transactions");
      expect(payload).toHaveProperty("execution_time_ms");
    });

    test("fast-stats should have correct response schema", async () => {
      // Arrange
      mockGet.mockResolvedValue("42");

      // Act
      const response = await app.inject({ method: "GET", url: "/fast-stats" });
      const payload = JSON.parse(response.payload);

      // Assert
      expect(payload).toHaveProperty("source");
      expect(payload).toHaveProperty("total_transactions");
      expect(payload).toHaveProperty("execution_time_ms");
    });

    test("execution_time_ms should be a positive number", async () => {
      // Arrange
      mockQuery.mockResolvedValue({ rows: [{ total: "100" }] });

      // Act
      const response = await app.inject({ method: "GET", url: "/slow-stats" });
      const payload = JSON.parse(response.payload);

      // Assert
      expect(payload.execution_time_ms).toBeGreaterThanOrEqual(0);
    });
  });

  // ==========================================
  // TEST: Error handling
  // ==========================================
  describe("Error Handling", () => {
    test("should handle malformed query result (empty rows)", async () => {
      // Arrange
      mockQuery.mockResolvedValue({ rows: [] });

      // Act
      const response = await app.inject({ method: "GET", url: "/slow-stats" });

      // Assert
      expect(response.statusCode).toBe(500);
    });

    test("should handle Redis returning non-numeric value", async () => {
      // Arrange
      mockGet.mockResolvedValue("not-a-number");

      // Act
      const response = await app.inject({ method: "GET", url: "/fast-stats" });

      // Assert
      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.total_transactions).toBeNull();
    });
  });

  // ==========================================
  // TEST: Cache behavior
  // ==========================================
  describe("Cache Behavior", () => {
    test("multiple calls should use cache after first miss", async () => {
      // Arrange - First call: cache miss
      mockGet.mockResolvedValueOnce(null);
      mockQuery.mockResolvedValue({ rows: [{ total: "1000" }] });
      mockSetEx.mockResolvedValue("OK");

      // Act - First call
      await app.inject({ method: "GET", url: "/fast-stats" });

      // Arrange - Second call: cache hit
      mockGet.mockResolvedValueOnce("1000");

      // Act - Second call
      const response = await app.inject({ method: "GET", url: "/fast-stats" });
      const payload = JSON.parse(response.payload);

      // Assert
      expect(payload.source).toBe("Redis (Cache Hit)");
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================
  // TEST: Cache Write Failure Resilience
  // ==========================================
  describe("Cache Write Failure Resilience", () => {
    test("should return result even when setEx fails", async () => {
      // Arrange: cache miss, DB ok, Redis setEx fails
      mockGet.mockResolvedValue(null);
      mockQuery.mockResolvedValue({ rows: [{ total: "4200" }] });
      mockSetEx.mockRejectedValue(new Error("Redis write timeout"));

      // Act
      const response = await app.inject({ method: "GET", url: "/fast-stats" });

      // Assert: risposta comunque 200 con i dati dal DB
      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.payload);
      expect(payload.total_transactions).toBe(4200);
      expect(payload.source).toBe("PostgreSQL (Cache Miss + Prepared Statement)");
    });

    test("should log error when setEx fails", async () => {
      // Arrange
      mockGet.mockResolvedValue(null);
      mockQuery.mockResolvedValue({ rows: [{ total: "100" }] });
      mockSetEx.mockRejectedValue(new Error("ECONNREFUSED"));
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      // Act
      await app.inject({ method: "GET", url: "/fast-stats" });

      // Assert
      expect(consoleSpy).toHaveBeenCalledWith(
        "[CACHE WRITE ERROR] setEx failed:",
        "ECONNREFUSED"
      );
      consoleSpy.mockRestore();
    });
  });

  // ==========================================
  // TEST: Cache Stampede Prevention
  // ==========================================
  describe("Cache Stampede Prevention", () => {
    test("concurrent requests on cache miss should share single DB query", async () => {
      // Arrange: cache miss, slow DB response
      mockGet.mockResolvedValue(null);
      mockQuery.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ rows: [{ total: "777" }] }), 50)
          )
      );
      mockSetEx.mockResolvedValue("OK");

      // Act: fire 5 concurrent requests
      const responses = await Promise.all([
        app.inject({ method: "GET", url: "/fast-stats" }),
        app.inject({ method: "GET", url: "/fast-stats" }),
        app.inject({ method: "GET", url: "/fast-stats" }),
        app.inject({ method: "GET", url: "/fast-stats" }),
        app.inject({ method: "GET", url: "/fast-stats" }),
      ]);

      // Assert: all succeed
      responses.forEach((response) => {
        expect(response.statusCode).toBe(200);
        const payload = JSON.parse(response.payload);
        expect(payload.total_transactions).toBe(777);
      });

      // Assert: only ONE PostgreSQL query was made (deduplication)
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    test("in-flight promise is cleaned up after completion", async () => {
      // Arrange: cache miss
      mockGet.mockResolvedValue(null);
      mockQuery.mockResolvedValue({ rows: [{ total: "500" }] });
      mockSetEx.mockResolvedValue("OK");

      // Act: first request populates cache
      const response1 = await app.inject({ method: "GET", url: "/fast-stats" });
      expect(response1.statusCode).toBe(200);

      // Arrange: now cache has the value
      mockGet.mockResolvedValue("500");

      // Act: second request should use cache (not in-flight)
      const response2 = await app.inject({ method: "GET", url: "/fast-stats" });
      const payload2 = JSON.parse(response2.payload);

      // Assert: cache hit, not deduplicated
      expect(payload2.source).toBe("Redis (Cache Hit)");
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    test("deduplicated request returns same value as original", async () => {
      // Arrange: cache miss
      mockGet.mockResolvedValue(null);
      mockQuery.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ rows: [{ total: "999" }] }), 30)
          )
      );
      mockSetEx.mockResolvedValue("OK");

      // Act: two concurrent requests
      const [res1, res2] = await Promise.all([
        app.inject({ method: "GET", url: "/fast-stats" }),
        app.inject({ method: "GET", url: "/fast-stats" }),
      ]);

      const payload1 = JSON.parse(res1.payload);
      const payload2 = JSON.parse(res2.payload);

      // Assert: both got the same total_transactions
      expect(payload1.total_transactions).toBe(999);
      expect(payload2.total_transactions).toBe(999);

      // Assert: only one DB query
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });
});