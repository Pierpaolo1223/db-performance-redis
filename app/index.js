import "dotenv/config"; 

import Fastify from "fastify";
import fastifyPostgres from "@fastify/postgres";
import { createClient } from "redis";

const fastify = Fastify({ logger: false });

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

fastify.get("/slow-stats", async (request, reply) => {
  const start = performance.now();
  try {
    const { rows } = await fastify.pg.query(PREPARED_QUERY);
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

fastify.get("/fast-stats", async (request, reply) => {
  const start = performance.now();
  try {
    const cachedValue = await redisClient.get(CACHE_KEY);

    if (cachedValue !== null) {
      const duration = performance.now() - start;
      return {
        source: "Redis (Cache Hit)",
        total_transactions: parseInt(cachedValue, 10),
        execution_time_ms: parseFloat(duration.toFixed(2)),
      };
    }

    const { rows } = await fastify.pg.query(PREPARED_QUERY);
    const total = rows[0].total;

    await redisClient.setEx(CACHE_KEY, 3600, total);

    const duration = performance.now() - start;
    return {
      source: "PostgreSQL (Cache Miss + Prepared Statement)",
      total_transactions: parseInt(total, 10),
      execution_time_ms: parseFloat(duration.toFixed(2)),
    };
  } catch (err) {
    reply.status(500).send({ error: err.message });
  }
});

const startServer = async () => {
  try {
    const connectionString = `postgres://postgres:${process.env.DB_PASSWORD}@localhost:5433/transactions`;
    fastify.register(fastifyPostgres, { connectionString });
    
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
