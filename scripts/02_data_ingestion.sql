SET synchronous_commit = off;

INSERT INTO transactions.transactions_partitioned (id, user_id, amount, created_at)
SELECT 
    gen_random_uuid(),
    floor(random() * 1000000)::int, 
    (random() * 10000)::decimal(10,2),
    '2026-01-01'::timestamp + (random() * 364 * interval '1 day')
FROM generate_series(1, 20000000);

INSERT INTO transactions.transactions_large (user_id, amount, created_at)
SELECT 
    floor(random() * 1000000)::int, 
    (random() * 10000)::decimal(10,2),
    '2026-01-01'::timestamp + (random() * 364 * interval '1 day')
FROM generate_series(1, 20000000);


ALTER TABLE transactions.transactions_partitioned 
ADD PRIMARY KEY (id, created_at, user_id);

ANALYZE verbose transactions.transactions_partitioned;
ANALYZE verbose transactions.transactions_large;
