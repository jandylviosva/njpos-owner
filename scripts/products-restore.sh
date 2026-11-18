#!/usr/bin/env bash
# Rebuilds a store's PRODUCT list from a nightly backup, corrected for the sales made since the backup. See docs/db-backup.md.
# Needs: SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_DB_URL (the live database), STORE_EMAIL. APPLY=yes writes to the live database; anything else only previews.
# Optional: BACKUP_FILE, BACKUP_BUCKET, PGBIN, PGSUPER, PGPORT (scratch server), OUT_DIR
set -euo pipefail
: "${SUPABASE_URL:?}" "${SUPABASE_SERVICE_KEY:?}" "${SUPABASE_DB_URL:?}" "${STORE_EMAIL:?}"
[[ "$STORE_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || { echo "bad email"; exit 1; }
BUCKET="${BACKUP_BUCKET:-db-backups}"; API="${SUPABASE_URL%/}/storage/v1"; PGBIN="${PGBIN:-}"; OUT_DIR="${OUT_DIR:-.}"
SU=${PGSUPER:-"sudo -u postgres"}; PORT="${PGPORT:-5432}"; here="$(cd "$(dirname "$0")" && pwd)"
if [[ "$SUPABASE_SERVICE_KEY" == sb_* ]]; then auth=(-H "apikey: ${SUPABASE_SERVICE_KEY}")
else auth=(-H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" -H "apikey: ${SUPABASE_SERVICE_KEY}"); fi
live() { "${PGBIN}psql" "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 "$@"; }
scratch() { $SU "${PGBIN}psql" -p "$PORT" -d restored_backup -v ON_ERROR_STOP=1 "$@"; }

if [ -z "${BACKUP_FILE:-}" ]; then
  BACKUP_FILE=$(curl -fsS "${auth[@]}" -H "Content-Type: application/json" -X POST "$API/object/list/${BUCKET}" -d '{"prefix":"daily","limit":1000}' \
    | jq -r '[.[] | select(.name|startswith("njpos-db-"))] | sort_by(.name) | last | .name')
fi
echo "using backup: $BACKUP_FILE"
curl -fsS "${auth[@]}" -o backup.dump "$API/object/${BUCKET}/daily/${BACKUP_FILE}"
$SU "${PGBIN}dropdb" -p "$PORT" --if-exists restored_backup; $SU "${PGBIN}createdb" -p "$PORT" restored_backup
$SU "${PGBIN}pg_restore" -p "$PORT" --no-owner --no-privileges -d restored_backup < backup.dump || echo "(pg_restore warnings about roles are normal)"

echo "reading this store's CURRENT orders from the live database"
live -Atq -c "select o::text from public.store_data sd join public.stores s on s.id = sd.store_id, jsonb_array_elements(coalesce(sd.orders,'[]'::jsonb)) o where lower(s.owner_email) = lower('${STORE_EMAIL}')" > live_orders.jsonl
scratch -q -c "create table live_orders(o jsonb)"
scratch -q -c "copy live_orders(o) from stdin (format csv, quote E'\\x01', delimiter E'\\x02')" < live_orders.jsonl
scratch -f - -v email="$STORE_EMAIL" < "$here/products-restore.sql"

scratch -Atq -c "select coalesce(jsonb_agg(p), '[]'::jsonb) from restore_products" > "$OUT_DIR/products.json"
N=$(jq 'length' "$OUT_DIR/products.json"); echo "products ready to restore: $N"
[ "$N" -gt 0 ] || { echo "the backup has no products for this store"; exit 1; }
STORE_ID=$(live -Atq -c "select id from public.stores where lower(owner_email) = lower('${STORE_EMAIL}')")
echo "products in the live store right now: $(live -Atq -c "select jsonb_array_length(coalesce(products,'[]')) from public.store_data where store_id = '${STORE_ID}'")"

if [ "${APPLY:-no}" != "yes" ]; then echo "PREVIEW ONLY: nothing was written. Run again with apply = yes to restore."; exit 0; fi

echo "APPLYING in chunks of 400 through the same database function the app uses (upsert_products)"
RUN="restore-$(date -u +%Y%m%d%H%M%S)"; rm -rf chunks; mkdir chunks
jq -c '[range(0; length; 400) as $i | .[$i:$i+400]] | to_entries[] | .value' "$OUT_DIR/products.json" | split -l 1 -d -a 4 - chunks/c_
i=0
for f in chunks/c_*; do
  i=$((i+1))
  live -q -v store="$STORE_ID" -v op="${RUN}-${i}" -v chunkfile="$PWD/$f" <<'SQL'
\set c `cat :chunkfile`
select (public.upsert_products(:'store'::uuid, :'op', :'c'::jsonb, true)->>'applied')::boolean as applied \gset
\if :applied
\else
\echo upsert did not apply
\quit 3
\endif
SQL
  echo "chunk $i applied"
done
echo "products in the live store now: $(live -Atq -c "select jsonb_array_length(coalesce(products,'[]')) from public.store_data where store_id = '${STORE_ID}'")"
