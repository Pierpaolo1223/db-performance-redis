CREATE SCHEMA IF NOT EXISTS transactions;

CREATE TABLE transactions.transactions_partitioned (
    id UUID,
    user_id INT,
    amount DECIMAL(10,2),
    created_at TIMESTAMP
) PARTITION BY RANGE (created_at);


CREATE TABLE transactions.transactions_large (
    id SERIAL PRIMARY KEY,
    user_id INT,
    amount DECIMAL(10,2),
    created_at TIMESTAMP
);

DO $$ 
BEGIN 
    FOR i IN 1..12 LOOP 
        EXECUTE format('CREATE TABLE transactions.%I PARTITION OF transactions.transactions_partitioned 
            FOR VALUES FROM (%L) TO (%L) 
            PARTITION BY HASH (user_id)', 
            'trans_2026_' || i, 
            format('2026-%s-01', i), 
            CASE WHEN i = 12 THEN '2027-01-01' ELSE format('2026-%s-01', i + 1) END
        );

        FOR h IN 0..3 LOOP
            EXECUTE format('CREATE TABLE transactions.%I PARTITION OF transactions.%I 
                FOR VALUES WITH (modulus 4, remainder %s)', 
                'trans_2026_' || i || '_h' || h, 
                'trans_2026_' || i, 
                h);
        END LOOP;
    END LOOP; 
END $$;


