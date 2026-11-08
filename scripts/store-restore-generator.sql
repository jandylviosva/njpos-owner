-- Run with psql against a database restored from a nightly backup:  psql -v email=owner@example.com -v safety=store_data_restore_safety_20261108 -At -f this.sql
-- Prints ONE ready-to-run script for the LIVE project. It puts back this store's users, roles, categories, theme/branding and settings
-- from the backup, and keeps anything the live store has that the backup does not. Orders, products and shifts are never touched.
--   users, roles: backup copy wins when the id exists in both; live-only entries are kept
--   categories:   union (same name kept once)
--   theme, order settings, UI settings: backup values win; keys that exist only live are kept; report*/lastReportSent* keep the LIVE value
select
  'begin;' || E'\n' ||
  format('create table if not exists public.%I as select * from store_data where store_id::text = (select id::text from stores where lower(owner_email)=%L);', :'safety', lower(:'email')) || E'\n' ||
  format('alter table public.%I enable row level security;', :'safety') || E'\n' ||
  format($f$
with src as (select %L::jsonb as accounts, %L::jsonb as roles, %L::jsonb as categories, %L::jsonb as th, %L::jsonb as os, %L::jsonb as ui),
live as (select * from store_data where store_id::text = (select id::text from stores where lower(owner_email)=%L))
update store_data sd
set accounts = (select coalesce(jsonb_agg(x order by o), '[]'::jsonb) from (
        select a as x, ord as o from jsonb_array_elements((select accounts from src)) with ordinality t(a, ord)
        union all
        select a, 100000 + ord from jsonb_array_elements(coalesce(sd.accounts,'[]')) with ordinality t2(a, ord)
        where not exists (select 1 from jsonb_array_elements((select accounts from src)) b where b->>'id' = a->>'id')) u),
    roles = (select coalesce(jsonb_agg(x order by o), '[]'::jsonb) from (
        select a as x, ord as o from jsonb_array_elements((select roles from src)) with ordinality t(a, ord)
        union all
        select a, 100000 + ord from jsonb_array_elements(coalesce(sd.roles,'[]')) with ordinality t2(a, ord)
        where not exists (select 1 from jsonb_array_elements((select roles from src)) b where b->>'id' = a->>'id')) u),
    categories = (select coalesce(jsonb_agg(x order by o), '[]'::jsonb) from (
        select c as x, ord as o from jsonb_array_elements(case when jsonb_typeof((select categories from src))='array' then (select categories from src) else '[]'::jsonb end) with ordinality t(c, ord)
        union all
        select c, 100000 + ord from jsonb_array_elements(case when jsonb_typeof(sd.categories)='array' then sd.categories else '[]'::jsonb end) with ordinality t2(c, ord)
        where not exists (select 1 from jsonb_array_elements(case when jsonb_typeof((select categories from src))='array' then (select categories from src) else '[]'::jsonb end) b where b = c)) u),
    theme = coalesce(case when jsonb_typeof(sd.theme)='object' then sd.theme end,'{}'::jsonb) || coalesce(case when jsonb_typeof((select th from src))='object' then (select th from src) end,'{}'::jsonb),
    order_settings = coalesce(case when jsonb_typeof(sd.order_settings)='object' then sd.order_settings end,'{}'::jsonb)
        || coalesce(case when jsonb_typeof((select os from src))='object' then (select os from src) end,'{}'::jsonb)
        || coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(case when jsonb_typeof(sd.order_settings)='object' then sd.order_settings else '{}'::jsonb end) e where e.key like 'report%%' or e.key like 'lastReportSent%%'),'{}'::jsonb),
    ui_settings = coalesce(case when jsonb_typeof(sd.ui_settings)='object' then sd.ui_settings end,'{}'::jsonb) || coalesce(case when jsonb_typeof((select ui from src))='object' then (select ui from src) end,'{}'::jsonb),
    updated_at = now()
where sd.store_id::text = (select id::text from stores where lower(owner_email)=%L);
$f$, coalesce(b.accounts,'[]'::jsonb)::text, coalesce(b.roles,'[]'::jsonb)::text, coalesce(b.categories,'[]'::jsonb)::text, coalesce(b.theme,'{}'::jsonb)::text,
     coalesce(b.order_settings,'{}'::jsonb)::text, coalesce(b.ui_settings,'{}'::jsonb)::text, lower(:'email'), lower(:'email')) || E'\n' ||
  format($c$select jsonb_array_length(accounts) as users, (select string_agg(a->>'username', ', ') from jsonb_array_elements(accounts) a) as usernames, (select string_agg(r->>'name', ', ') from jsonb_array_elements(roles) r) as roles, jsonb_array_length(categories) as categories, theme->>'storeName' as store_name from store_data where store_id::text = (select id::text from stores where lower(owner_email)=%L);$c$, lower(:'email')) || E'\n' ||
  'commit;'
from store_data b where b.store_id::text = (select id::text from stores where lower(owner_email)=lower(:'email'));
