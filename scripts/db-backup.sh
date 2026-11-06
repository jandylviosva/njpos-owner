#!/usr/bin/env bash
# Daily full backup of the POS database (public schema) into a private Supabase Storage bucket.
# Needs: SUPABASE_DB_URL, SUPABASE_URL, SUPABASE_SERVICE_KEY   (see docs/db-backup.md). Optional: BACKUP_BUCKET (default db-backups), KEEP_DAYS (default 30)
set -euo pipefail
: "${SUPABASE_DB_URL:?}" "${SUPABASE_URL:?}" "${SUPABASE_SERVICE_KEY:?}"
BUCKET="${BACKUP_BUCKET:-db-backups}"; KEEP_DAYS="${KEEP_DAYS:-30}"; API="${SUPABASE_URL%/}/storage/v1"
auth=(-H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" -H "apikey: ${SUPABASE_SERVICE_KEY}")

stamp="$(date -u +%Y-%m-%d_%H%M)"
file="njpos-db-${stamp}.dump"

# custom format = compressed, and lets us restore one table or the whole thing. The one-off store_data_backup_* copies are skipped.
pg_dump "$SUPABASE_DB_URL" --format=custom --compress=9 --no-owner --no-privileges --schema=public \
  --exclude-table='public.store_data_backup*' --file="$file"

size=$(stat -c %s "$file")
echo "dump size: $size bytes"
if [ "$size" -lt 100000 ]; then echo "backup is suspiciously small - refusing to upload"; exit 1; fi
pg_restore --list "$file" > /dev/null          # proves the file is readable
pg_restore --list "$file" | grep -q "TABLE DATA public store_data " || { echo "store_data is missing from the dump"; exit 1; }

# the bucket is private; creating it again just answers "already exists"
curl -sS -o /dev/null "${auth[@]}" -H "Content-Type: application/json" -X POST "$API/bucket" -d "{\"id\":\"${BUCKET}\",\"name\":\"${BUCKET}\",\"public\":false}" || true

curl -fsS "${auth[@]}" -H "Content-Type: application/octet-stream" -H "x-upsert: true" -X POST \
  --data-binary "@${file}" "$API/object/${BUCKET}/daily/${file}" > /dev/null
echo "uploaded daily/${file}"

# keep only the newest KEEP_DAYS days
cutoff="$(date -u -d "-${KEEP_DAYS} days" +%Y-%m-%dT%H:%M:%S)"
old=$(curl -fsS "${auth[@]}" -H "Content-Type: application/json" -X POST "$API/object/list/${BUCKET}" -d '{"prefix":"daily","limit":1000}' \
  | jq -c --arg cutoff "$cutoff" '[.[] | select(.name|startswith("njpos-db-")) | select(.created_at < $cutoff) | "daily/" + .name]')
if [ "$old" != "[]" ]; then
  curl -fsS "${auth[@]}" -H "Content-Type: application/json" -X DELETE "$API/object/${BUCKET}" -d "{\"prefixes\":${old}}" > /dev/null
  echo "removed old backups: $old"
fi
