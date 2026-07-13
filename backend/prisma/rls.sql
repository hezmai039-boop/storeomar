-- Row-Level Security — second, independent isolation layer described in
-- docs/01-database-design.md §10. Applied on top of the Prisma-managed
-- schema; the app sets `app.accessible_store_ids` per request (see
-- src/db/prisma.ts) before running any query.
--
-- Safe to re-run: policies are dropped and recreated each time.

do $$
declare
  t text;
  tables text[] := array[
    'channel_accounts', 'customers', 'conversations', 'messages',
    'knowledge_sources', 'knowledge_chunks', 'ai_agents',
    'ai_suggested_knowledge', 'ai_response_logs',
    'ticket_departments', 'tickets', 'ticket_events',
    'integrations', 'synced_orders', 'synced_products',
    'store_daily_metrics',
    'ai_specialists', 'ai_tool_invocations', 'ai_orchestrator_runs',
    'ai_customer_memory', 'ai_conversation_memory', 'ai_business_memory'
  ];
begin
  foreach t in array tables loop
    execute format('alter table %I enable row level security', t);
    -- No FORCE here on purpose: the migrator role (DATABASE_URL) has
    -- BYPASSRLS, and BYPASSRLS always wins over FORCE regardless — so FORCE
    -- would be a no-op for that role anyway. What actually enforces
    -- isolation is that the app's own connection (APP_DATABASE_URL) uses a
    -- role WITHOUT BYPASSRLS, so ENABLE alone already applies these
    -- policies to it. Dropping FORCE is what lets this run unchanged
    -- against providers (e.g. Neon's free tier) that only expose a single
    -- owner role and won't grant BYPASSRLS to a second one.
    execute format('drop policy if exists store_isolation on %I', t);

    if t = 'ticket_events' then
      -- ticket_events has no store_id column directly; scope via its parent ticket.
      execute format($f$
        create policy store_isolation on %I
        using (
          ticket_id in (
            select id from tickets where store_id = any (
              string_to_array(current_setting('app.accessible_store_ids', true), ',')::uuid[]
            )
          )
        )
      $f$, t);
    else
      execute format($f$
        create policy store_isolation on %I
        using (
          store_id = any (
            string_to_array(current_setting('app.accessible_store_ids', true), ',')::uuid[]
          )
        )
      $f$, t);
    end if;
  end loop;
end $$;

-- audit_logs: store_id is nullable (organization-level events allowed through),
-- so the policy accepts either a matching store or an organization-level row.
alter table audit_logs enable row level security;
drop policy if exists store_isolation on audit_logs;
create policy store_isolation on audit_logs
using (
  store_id is null
  or store_id = any (
    string_to_array(current_setting('app.accessible_store_ids', true), ',')::uuid[]
  )
);
