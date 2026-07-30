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
    'ai_customer_memory', 'ai_conversation_memory', 'ai_business_memory',
    'simulation_links'
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

-- ------------------------------------------------------------------
-- Tables with a store_id that are DELIBERATELY excluded from the loop
-- above. Adding a store_isolation policy to either would break a
-- working flow, so this list exists to stop the next person "fixing"
-- an apparent oversight — docs/29 states the rule that every store_id
-- table gets a policy, and these are its two documented exceptions.
--
--   oauth_states
--     Read by GET /v1/integrations/oauth/:platform/callback, which is a
--     browser redirect from Salla/Zid with no session and therefore no
--     app.accessible_store_ids set. A policy keyed on that setting would
--     match nothing and every merchant's connect flow would fail. The
--     row is protected by its own 32-byte single-use `state` secret
--     instead — knowing it IS the proof of having initiated the flow —
--     and no API route lists or enumerates the table.
--
--   user_store_roles
--     Read by resolveAccess() in middleware/rbac.ts to work out which
--     stores a user may touch. That query necessarily runs BEFORE store
--     context exists — it is what computes the context — so a policy
--     depending on the context would be circular and deny everyone.
--     Scoped explicitly by userId + store.organizationId at the query.
-- ------------------------------------------------------------------

-- ------------------------------------------------------------------
-- Tables with NO store_id, and therefore no store_isolation policy.
--
-- The loop above only visits tables that HAVE a store_id column, so these
-- are skipped automatically — this note exists so that absence reads as a
-- decision rather than an oversight during the next audit.
--
--   plans, subscriptions, usage_counters, invoices
--     Organization-scoped billing (docs/25-billing-and-plans.md §1). There
--     is no store_id for a policy to match on. Isolation is the API layer:
--     every billing route derives the organization id from the signed JWT,
--     never from a body, param, or query.
--
--   plan_requests
--     A landing-page LEAD: no organization, no user, no session behind it,
--     because none of those exist until the platform owner activates a plan
--     for that person. It has nothing to be isolated against. The public
--     endpoint can only INSERT; every read is behind requirePlatformAdmin().
--     A row here grants nothing — entitlement still comes only from
--     subscriptions — which is what makes an unauthenticated write to it
--     acceptable at all.
-- ------------------------------------------------------------------
