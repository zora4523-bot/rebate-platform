-- B3-08g: the switches of the four Agent tools this segment registers (08 BR-AI-02 细则「开关」:
-- MVP tools default on; 04 §10.2). Synthetic app_id only. search_products / get_rebate_quote are
-- not part of this file, and agent.explain_order.order_no_daily_max / agent.orders.max_span_days
-- are not seeded (code defaults cover them, BR-AI-07).
-- Re-runnable: ON CONFLICT DO NOTHING keeps every existing value and revision, including a switch
-- an operator turned off. Uses only INSERT, so it also runs as couli_app.

INSERT INTO app.config_items (app_id, key, value, updated_by) VALUES
  ('couli', 'agent.tools.handoff_to_human.enabled', 'true'::jsonb, 'seed'), -- BR-AI-02 细则
  ('couli', 'agent.tools.prefill_claim.enabled', 'true'::jsonb, 'seed'), -- BR-AI-02 细则
  ('couli', 'agent.tools.list_my_orders.enabled', 'true'::jsonb, 'seed'), -- BR-AI-02 细则
  ('couli', 'agent.tools.explain_order.enabled', 'true'::jsonb, 'seed') -- BR-AI-02 细则
ON CONFLICT (app_id, key) DO NOTHING;
