# High-Performance Metrics Aggregation: PostgreSQL vs Redis Cache

This repository demonstrates how to scale massive aggregation and complex data processing queries over an enterprise financial database containing 40 million records. The objective of this benchmark is to analyze the performance degradation of a relational database (PostgreSQL) under heavy stress testing and to demonstrate the mitigation of latency through an in-memory caching strategy (Redis) using the Cache-Aside pattern and Named Prepared Statements.

## System Architecture and Use Cases

In high-traffic production environments (Fintech and E-Commerce), relational databases should act as log systems or ledgers ensuring data consistency and persistence over the long term, rather than real-time processors of massive metrics.

### Business Use Cases Addressed:
1. **Dynamic Reporting and Estemporary Aggregations**: Calculating monthly totals filtering by business logic that cannot be indexed a priori (e.g., tracking transactions ending in .99 cents).
2. **Load Decoupling**: Protecting the CPU of the main transactional database by blocking heavy read traffic at the RAM layer before it touches the storage disks.
3. **High-Concurrency Counter Management**: Leveraging the single-threaded, atomic nature of Redis for high-frequency real-time counters (e.g., inventory stock tracking, rate limiting) to eliminate table or row locking conflicts.

---

## Redis vs PostgreSQL Materialized Views

While a PostgreSQL Materialized View pre-computes and stores the aggregation results on disk to speed up reads, it introduces severe architectural trade-offs when compared to a dedicated Redis caching layer:

1. **Distributed Architecture and Microservices Readiness**: Redis operates as a centralized, decoupled data store accessible over the network. If the infrastructure scales from a monolith to a microservices architecture, any independent service can access the cached metrics instantly without alterations. Conversely, a Materialized View is tightly coupled and encapsulated inside a specific relational database instance, creating a bottleneck and restricting cross-service accessibility.
2. **Non-Blocking Dynamic Updates**: Refreshing a PostgreSQL Materialized View (`REFRESH MATERIALIZED VIEW`) is an expensive database transaction that locks table resources, triggers disk I/O, and causes request queuing or latency spikes under heavy concurrent load. Redis processes updates and invalidations using non-blocking, asynchronous, or atomic operations in RAM, guaranteeing continuous availability with zero impact on incoming user requests.
3. **Storage Placement and Network I/O Efficiency**: Although a Materialized View persists data to a hard drive, in enterprise environments this storage is hosted on remote database clusters or cloud volumes, adding network and filesystem layer overhead. Redis resides directly in volatile memory (RAM), eliminating disk read latency entirely and providing a unified caching protocol that bypasses the complex relational engine abstraction.


## Technology Stack and Configuration

* **Runtime**: Node.js (Native ES Modules)
* **Web Framework**: Fastify (Selected for maximum throughput and native data stream management)
* **Databases**: PostgreSQL 14 + Redis 7.2 (Alpine) orchestrated via Docker Compose.

### Low-Level Performance Tuning:
* **Memory Tuning (PostgreSQL)**: Allocation of 512MB for shared_buffers` and 64MB for work_mem within the Docker container to prevent Out-Of-Memory (OOM Killer) crashes during full table scans.
* **Prepared Statements**: Implementation of parameterized and named queries (fetch-transactions-modulo-cents) in the Node.js driver. This forces PostgreSQL to cache the execution plan in RAM, completely eliminating the 17ms Planning Time observed during cold query executions.

---

## Benchmark Environment

To ensure reproducibility, all performance tests and system metrics were recorded locally using a single-host deployment on the following hardware configuration:

* **CPU**: Intel Core i7-6700HQ (4 Cores, 8 Threads, up to 3.50 GHz)
* **Memory**: 16 GB DDR4 RAM
* **Storage**: High-Speed Solid-State Drive (SSD)
* **Operating System**: Linux / Ubuntu (Docker Engine Environment)

---

## Benchmark Results (Autocannon)

The stress tests were executed simulating a highly competitive load of 2,000 concurrent connections sustained for 60 seconds.


| Metric | PostgreSQL Direct (/slow-stats) | Redis Cache Hit (/fast-stats) |
| :--- | :--- | :--- |
| **Total Requests** | 13,000 (Only 2,000 completed) | **466,000 (All completed)** |
| **Average Throughput** | 0.12 Req/Sec | **7,867.82 Req/Sec** |
| **Network Errors (Timeouts)** | 11,000 (85% failure rate) | **0 (Absolute Stability)** |
| **Average Latency** | 5,827.58 ms (5.8 seconds) | **260.48 ms** |
| **Hardware State** | **CPU at 100% / Thread Saturation** | **CPU Idle / Graceful Scaling** |

### Technical Analysis of the Counter Metrics:
* **The Relational Collapse**: Direct PostgreSQL queries fail 85% of the time. The mathematical modulo calculation performed row-by-row across 20M records causes a massive process backlog that saturates the database engine cores, pushing latency to nearly 6 seconds.
* **The Redis Shield**: By moving the pre-calculated dataset into volatile memory, the system experiences a throughput increase of 65,000x. The residual 260ms latency measured under extreme stress is entirely related to the TCP network socket processing overhead of the Node.js Event Loop on the local machine.

---

## Execution and Replication Setup

1. Clone the repository and configure the .env file in the root directory by providing the database password (DB_PASSWORD).
2. Boot up the infrastructure using Docker Compose:
   ```bash
   docker compose up -d
   ```
3. Enter the application directory and install the necessary dependencies:
   ```bash
   cd app && npm install
   ```
4. Start the Fastify server:
   ```bash
   npm start
   ```
5. Trigger a single manual request to initialize the Cold Start (forcing PostgreSQL to compute the metric once and store the result into the Redis key):
   ```bash
   curl http://localhost:3000/fast-stats
   ```
6. Run the load test suites using Autocannon:
   ```bash
   # Test PostgreSQL Baseline Performance
   autocannon -c 2000 -d 60 http://localhost:3000/slow-stats

   # Test Redis Caching Performance
   autocannon -c 2000 -d 60 http://localhost:3000/fast-stats
   ```
