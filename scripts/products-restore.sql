-- Runs inside the scratch database that holds the restored BACKUP, after live_orders (this store's CURRENT orders from the live database) was loaded.
-- Builds restore_products = the backup's product list with each stock reduced by what the PAID orders sold since the backup (orders that are
-- in live but not in the backup). psql variable: email.
drop table if exists sold_since, restore_products, bk_ids;
create table bk_ids as
  select distinct o->>'id' as id
  from store_data sd join stores s on s.id = sd.store_id, jsonb_array_elements(coalesce(sd.orders,'[]')) o
  where lower(s.owner_email) = lower(:'email');
create table sold_since as
  select coalesce(i->>'productId', i->>'id') as pid, nullif(i->>'variantId','') as vid, sum(coalesce(nullif(i->>'qty','')::numeric,0)) as qty
  from live_orders lo, jsonb_array_elements(coalesce(lo.o->'items','[]')) i
  where lo.o->>'status' = 'paid' and not exists (select 1 from bk_ids b where b.id = lo.o->>'id')
  group by 1, 2;
create table restore_products as
select case
  when jsonb_typeof(p->'variants') = 'array' and jsonb_array_length(p->'variants') > 0 then
    jsonb_set(
      case when p->>'variantStockMode' = 'shared' and nullif(p->>'sharedStock','') is not null
           then jsonb_set(p, '{sharedStock}', to_jsonb(greatest(0, (p->>'sharedStock')::numeric - coalesce((select sum(qty) from sold_since x where x.pid = p->>'id'), 0))))
           else p end,
      '{variants}',
      (select jsonb_agg(case when nullif(v->>'stock','') is not null
                             then jsonb_set(v, '{stock}', to_jsonb(greatest(0, (v->>'stock')::numeric - coalesce((select sum(qty) from sold_since x where x.pid = p->>'id' and x.vid = v->>'id'), 0))))
                             else v end order by ord)
         from jsonb_array_elements(p->'variants') with ordinality t(v, ord)))
  when nullif(p->>'stock','') is not null then
    jsonb_set(p, '{stock}', to_jsonb(greatest(0, (p->>'stock')::numeric - coalesce((select sum(qty) from sold_since x where x.pid = p->>'id'), 0))))
  else p end as p
from store_data sd join stores s on s.id = sd.store_id, jsonb_array_elements(coalesce(sd.products,'[]')) p
where lower(s.owner_email) = lower(:'email');

\echo ===== REPORT =====
select 'products in the backup' as what, count(*)::text as value from restore_products
union all select 'paid orders in live that are not in the backup (sold since)', count(*)::text from live_orders lo where lo.o->>'status'='paid' and not exists (select 1 from bk_ids b where b.id = lo.o->>'id')
union all select 'units sold since the backup', coalesce(sum(qty),0)::text from sold_since
union all select 'products whose stock goes down because of those sales', count(distinct pid)::text from sold_since where pid in (select p->>'id' from restore_products)
union all select 'sold items whose product is NOT in the backup (created after it)', count(*)::text from sold_since where pid not in (select p->>'id' from restore_products)
union all select 'simple products whose stock would be below zero (shown as 0)', count(*)::text from (
    select x.pid from sold_since x join store_data sd on true join stores s on s.id = sd.store_id and lower(s.owner_email) = lower(:'email'),
         jsonb_array_elements(coalesce(sd.products,'[]')) p
    where x.vid is null and p->>'id' = x.pid and nullif(p->>'stock','') is not null and (p->>'stock')::numeric < x.qty) z;
