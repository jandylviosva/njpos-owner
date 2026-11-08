#!/usr/bin/env bash
# Builds a restore script for ONE store from a nightly backup (see docs/db-backup.md). Needs: SUPABASE_URL, SUPABASE_SERVICE_KEY, STORE_EMAIL.
# Optional: BACKUP_FILE (a name under daily/ in the db-backups bucket; default = the newest), BACKUP_BUCKET, OUT (default restore-script.sql), PGBIN (psql/pg_restore folder), PGSUPER (psql prefix for the scratch server)
set -euo pipefail
: "${SUPABASE_URL:?}" "${SUPABASE_SERVICE_KEY:?}" "${STORE_EMAIL:?}"
BUCKET="${BACKUP_BUCKET:-db-backups}"; API="${SUPABASE_URL%/}/storage/v1"; OUT="${OUT:-restore-script.sql}"; PGBIN="${PGBIN:-}"
if [[ "$SUPABASE_SERVICE_KEY" == sb_* ]]; then auth=(-H "apikey: ${SUPABASE_SERVICE_KEY}")
else auth=(-H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" -H "apikey: ${SUPABASE_SERVICE_KEY}"); fi
here="$(cd "$(dirname "$0")" && pwd)"

if [ -z "${BACKUP_FILE:-}" ]; then
  BACKUP_FILE=$(curl -fsS "${auth[@]}" -H "Content-Type: application/json" -X POST "$API/object/list/${BUCKET}" -d '{"prefix":"daily","limit":1000,"sortBy":{"column":"name","order":"desc"}}' \
    | jq -r '[.[] | select(.name|startswith("njpos-db-"))] | sort_by(.name) | last | .name')
fi
[ -n "$BACKUP_FILE" ] && [ "$BACKUP_FILE" != "null" ] || { echo "no backup file found"; exit 1; }
echo "using backup: $BACKUP_FILE"
curl -fsS "${auth[@]}" -o backup.dump "$API/object/${BUCKET}/daily/${BACKUP_FILE}"

SU=${PGSUPER:-"sudo -u postgres"}; PORT="${PGPORT:-5432}"
$SU "${PGBIN}dropdb" -p "$PORT" --if-exists restored_backup; $SU "${PGBIN}createdb" -p "$PORT" restored_backup
$SU "${PGBIN}pg_restore" -p "$PORT" --no-owner --no-privileges -d restored_backup "$(pwd)/backup.dump" || echo "(pg_restore reported warnings, usually about database roles; continuing)"
$SU "${PGBIN}psql" -p "$PORT" -d restored_backup -Atc "select 'store_data rows in backup: ' || count(*) from store_data"
safety="store_data_restore_safety_$(date -u +%Y%m%d_%H%M)"
$SU "${PGBIN}psql" -p "$PORT" -d restored_backup -v ON_ERROR_STOP=1 -v email="$STORE_EMAIL" -v safety="$safety" -At -f "$here/store-restore-generator.sql" > "$OUT"
[ -s "$OUT" ] || { echo "no store with that email in the backup"; exit 1; }
echo "restore script written to $OUT ($(wc -c < "$OUT") bytes), safety copy table: $safety"
