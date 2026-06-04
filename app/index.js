import "dotenv/config";

import Fastify from "fastify";
import fastifyPostgres from "@fastify/postgres";
import { createClient } from "redis";

const fastify = Fastify({ logger: false });

const connectionString = `postgres://postgres:postgres@localhost:5433/transactions`;
fastify.register(fastifyPostgres, { connectionString });

const redisClient = createClient({ url: process.env.REDIS_URL });
redisClient.on("error", (err) => console.error("Redis Client Error", err));
await redisClient.connect();

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

const inFlightRequests = new Map();

// Cleanup automatico delle entry più vecchie di 30s per prevenire memory leak
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of inFlightRequests) {
    if (now - entry.timestamp > 30000) {
      inFlightRequests.delete(key);
    }
  }
}, 5000);

process.on("exit", () => inFlightRequests.clear());
process.on("SIGINT", () => {
  inFlightRequests.clear();
  process.exit();
});
process.on("SIGTERM", () => {
  inFlightRequests.clear();
  process.exit();
});

fastify.get("/slow-stats", async (request, reply) => {
  const start = performance.now();
  try {
    const { rows } = await fastify.pg.query(PREPARED_QUERY);

    if (rows.length === 0) {
      return {
        source: "PostgreSQL (Prepared Statement)",
        total_transactions: "0",
        execution_time_ms: parseFloat((performance.now() - start).toFixed(2)),
        warning: "Query returned no rows",
      };
    }

    const rawTotal = rows[0].total;
    if (rawTotal === null || rawTotal === undefined || rawTotal === "") {
      return {
        source: "PostgreSQL (Prepared Statement)",
        total_transactions: "0",
        execution_time_ms: parseFloat((performance.now() - start).toFixed(2)),
        warning: "Query returned null or empty total",
      };
    }

    const duration = performance.now() - start;
    return {
      source: "PostgreSQL (Prepared Statement)",
      total_transactions: BigInt(rows[0].total).toString(),
      execution_time_ms: parseFloat(duration.toFixed(2)),
    };
  } catch (err) {
    reply.status(500).send({ error: err.message });
  }
});

fastify.get("/fast-stats", async (request, reply) => {
   try {
    const redisStart = performance.now();
    const cachedValue = await redisClient.get(CACHE_KEY);

    if (cachedValue !== null && cachedValue !== "") {
      try {
        const parsedValue = BigInt(String(cachedValue));
        const duration = performance.now() - redisStart;
        return {
          source: "Redis (Cache Hit)",
          total_transactions: parsedValue.toString(),
          execution_time_ms: parseFloat(Math.max(0.01, duration).toFixed(2)),
        };
      } catch (parseError) {
        // Se il valore non è valido, continua con la logica di cache miss
        console.log("[CACHE] Invalid value detected, falling back to DB:", cachedValue);
      }
    }

    if (inFlightRequests.has(CACHE_KEY)) {
      const result = await inFlightRequests.get(CACHE_KEY).promise;
      result.source = "Redis (Cache Hit - Deduplicated)";
      return result;
    }
    const start = performance.now();
    const promise = (async () => {
      try {
        const { rows } = await fastify.pg.query(PREPARED_QUERY);

        if (rows.length === 0) {
          const duration = performance.now() - start;
          return {
            source: "PostgreSQL (Cache Miss + Prepared Statement)",
            total_transactions: 0,
            execution_time_ms: parseFloat(duration.toFixed(2)),
            warning: "Query returned no rows",
          };
        }

        const rawTotal = rows[0].total;
        if (rawTotal === null || rawTotal === undefined || rawTotal === "") {
          const duration = performance.now() - start;
          return {
            source: "PostgreSQL (Cache Miss + Prepared Statement)",
            total_transactions: 0,
            execution_time_ms: parseFloat(duration.toFixed(2)),
            warning: "Query returned null or empty total",
          };
        }

        const total = rawTotal;

        try {
          await redisClient.setEx(CACHE_KEY, 3600, total);
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

    inFlightRequests.set(CACHE_KEY, { promise, timestamp: Date.now() });
    const result = await promise;
    return result;
  } catch (err) {
    reply.status(500).send({ error: err.message });
  }
});

const startServer = async () => {
  try {
    await fastify.listen({ port: process.env.PORT || 3000 });
    console.log(
      `Fastify server loaded on http://localhost:${process.env.PORT || 3000}`,
    );
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

startServer();


