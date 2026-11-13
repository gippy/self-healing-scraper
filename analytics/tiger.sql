-- Tiger Data: the auction house records every bid in the `bids` hypertable (time, lot_id, amount).
-- lot_price_1m is a continuous aggregate: each lot's highest bid and number of bids per minute,
-- refreshed every minute by TimescaleDB.
CREATE MATERIALIZED VIEW IF NOT EXISTS lot_price_1m WITH (timescaledb.continuous) AS
SELECT lot_id, time_bucket('1 minute', time) AS minute, max(amount) AS price, count(*)::int AS bids
FROM bids
GROUP BY lot_id, minute
WITH NO DATA;

SELECT add_continuous_aggregate_policy('lot_price_1m',
  start_offset => INTERVAL '2 hours',
  end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists => true);

-- How fast each lot's price grew, from its per-minute history.
SELECT p.lot_id, l.title,
  (array_agg(p.price ORDER BY p.minute))[1] AS first_price,
  (array_agg(p.price ORDER BY p.minute DESC))[1] AS latest_price,
  round(100 * ((array_agg(p.price ORDER BY p.minute DESC))[1] / (array_agg(p.price ORDER BY p.minute))[1] - 1), 1) AS growth_pct
FROM lot_price_1m p
JOIN lots l ON l.id = p.lot_id
GROUP BY p.lot_id, l.title
HAVING count(*) > 2
ORDER BY growth_pct DESC
LIMIT 10;
