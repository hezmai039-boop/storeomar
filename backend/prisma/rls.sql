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
    'store_daily_metrics'
  ];
begin
  foreach t in array tables loop
    execute format('alter table %I enable row level security', t);
    -- Without FORCE, Postgres skips RLS for the table owner — and in this
    -- single-user docker-compose setup the app connects AS the owner, so
    -- this line is what actually makes the policy bite.
    execute format('alter table %I force row level security', t);
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
alter table audit_logs force row level security;
drop policy if exists store_isolation on audit_logs;
create policy store_isolation on audit_logs
using (
  store_id is null
  or store_id = any (
    string_to_array(current_setting('app.accessible_store_ids', true), ',')::uuid[]
  )
);
