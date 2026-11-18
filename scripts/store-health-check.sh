#!/usr/bin/env bash
# Hourly check: does any store that has real sales (50+ orders) look wiped (no users, or no products)?
# Exits with an error (so GitHub emails the repository owner) and prints which stores. Needs: SUPABASE_DB_URL. Optional: PGBIN.
set -euo pipefail
: "${SUPABASE_DB_URL:?}"
PGBIN="${PGBIN:-}"
out=$("${PGBIN}psql" "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -At -F ' | ' <<'SQL'
select s.store_name,
       'users=' || jsonb_array_length(coalesce(sd.accounts,'[]')) ||
       ' products=' || jsonb_array_length(coalesce(sd.products,'[]')) ||
       ' categories=' || jsonb_array_length(coalesce(sd.categories,'[]')) ||
       ' orders=' || jsonb_array_length(coalesce(sd.orders,'[]')) ||
       case when coalesce(sd.theme->>'storeName','') in ('', 'My Store') then ' store-name-reset' else '' end as detail
from public.store_data sd join public.stores s on s.id = sd.store_id
where jsonb_array_length(coalesce(sd.orders,'[]')) >= 50
  and ( jsonb_array_length(coalesce(sd.accounts,'[]')) = 0
     or jsonb_array_length(coalesce(sd.products,'[]')) = 0 )
order by 1;
SQL
)
if [ -n "$out" ]; then
  echo "STORE LOOKS WIPED (it has sales but no users or no products):"
  echo "$out"
  exit 1
fi
echo "all stores with sales look normal"
