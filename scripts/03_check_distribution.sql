SELECT 
    tableoid::regclass AS module_name, 
    COUNT(*) AS rows_in_module
FROM transactions.trans_2026_1 
GROUP BY tableoid;


SELECT relname, reltuples::bigint 
FROM pg_class 
WHERE relname LIKE 'trans_2026_%_h%' 
ORDER BY relname;

