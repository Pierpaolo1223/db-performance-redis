# SKILLS.md — Project Learnings

<project-rules>
- Test files live in `app/__tests__/` with `*.test.js` suffix
- Jest 30.x with ESM: run via `NODE_OPTIONS=--experimental-vm-modules npx jest`
- `jest.config.js`: `transform: {}`, testMatch `**/__tests__/**/*.test.js`
- No external mock libraries — pure `jest.fn()` mocks
- Each test creates a fresh Fastify instance in `beforeEach` via `Fastify({ logger: false })`
- Dependencies mocked manually: `app.decorate("pg", { query: jest.fn() })` and plain object for Redis
- Routes re-registered inline per test (not imported from `index.js`) to avoid module-level side effects
- `fastify.inject()` used for HTTP-level testing without binding ports
</project-rules>

<avoided-errors>
- **NaN vs null in JSON round-trip**: `parseInt("not-a-number", 10)` → `NaN`, but `JSON.stringify(NaN)` → `null`. After `JSON.parse`, the value is `null` not `NaN`. Assert with `toBeNull()` not `toBeNaN()`.

- **Cache stampede vulnerability**: Naive cache-aside (GET → miss → query DB → SET) produces N identical DB queries for N concurrent requests. Fixed with `Map<string, Promise>` request deduplication — concurrent requests attach to the same in-flight Promise. `finally` block cleans the Map on both success and error.

- **Cache write failure masking valid data**: If `setEx` fails after `pg.query()` succeeds, a single try/catch would return 500 despite having valid data. Fixed by wrapping `setEx` in an isolated try/catch — log the error via `console.error()` but still return the DB result to the caller.

- **Empty rows crash**: `rows[0].total` throws `TypeError` when query returns zero rows. Fixed with `rows.length === 0` guard returning `{ total_transactions: 0, warning: "Query returned no rows" }`.

- **Conflicting test runner**: `app/index.test.js` used `node:test` while project uses Jest — caused `Cannot find module 'test'` errors. Removed the conflicting file.
</avoided-errors>

<architectural-context>
- Fastify 5.x ESM app with two endpoints:
  - `GET /slow-stats`: direct PostgreSQL query with prepared statement (no cache)
  - `GET /fast-stats`: Redis cache-aside (TTL 3600s) + Promise deduplication anti-stampede
- PostgreSQL returns `COUNT(*)::text` as string; Redis stores/returns strings; `parseInt(value, 10)` converts everywhere
- Cache key: `stats:2026-10:99_cents`, prepared query name: `fetch-transactions-modulo-cents`
- Query filters: `created_at >= 2026-10-01 AND created_at < 2026-11-01 AND (amount % 1) = 0.99`
- Mock pattern: `jest.fn()` for `pg.query`, `redis.get`, `redis.setEx`; plain object `{ get, setEx, on, connect }` for Redis client
- `inFlightRequests` Map shared per `beforeEach` scope; stampede tested via `Promise.all()` with slow mock (`setTimeout`)
</architectural-context>
