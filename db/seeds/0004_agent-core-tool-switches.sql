-- B3-08j: the switches of the two core Agent tools search_products / get_rebate_quote (08 BR-AI-02
-- 细则「开关」: MVP tools default on; 04 §10.2; D10-273 ①). 0003 seeds the other four MVP tools;
-- without these two rows the registry reads the switch as off and a fresh database starts with
-- product search and rebate quotes disabled. Synthetic app_id only. P1 tool switches
-- (create_watch / list_watches / cancel_watch, default off) and agent.explain_order.order_no_daily_max /
-- agent.orders.max_span_days are not seeded (code defaults cover them, BR-AI-07).
-- Re-runnable: ON CONFLICT DO NOTHING keeps every existing value and revision, including a switch
-- an operator turned off. Uses only INSERT, so it also runs as couli_app.

INSERT INTO app.config_items (app_id, key, value, updated_by) VALUES
  ('couli', 'agent.tools.search_products.enabled', 'true'::jsonb, 'seed'), -- BR-AI-02 细则
  ('couli', 'agent.tools.get_rebate_quote.enabled', 'true'::jsonb, 'seed') -- BR-AI-02 细则
ON CONFLICT (app_id, key) DO NOTHING;
