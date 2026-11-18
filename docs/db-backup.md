# Daily database backup

A GitHub job (`.github/workflows/db-backup.yml`) runs every day at 3:30 AM Philippine time. It copies the whole `public`
schema of the Supabase database into a compressed file and uploads it to a private Supabase Storage bucket. It does not touch the
app and does not lock anything. GitHub emails the repository owner if a run fails.

## One-time setup (about 5 minutes)
1. **Supabase connection string**: Project -> Connect -> *Session pooler* (or Direct connection) -> URI. Replace `[YOUR-PASSWORD]` with the database password.
2. **Supabase URL and service key**: Project Settings -> API -> *Project URL* and the **Secret key** (`sb_secret_...`, the new name for `service_role`; never put it in the app or in chat).
3. **GitHub**: repository `njpos-owner` -> Settings -> Secrets and variables -> Actions -> New repository secret. Add three secrets:
   `SUPABASE_DB_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.
4. Actions tab -> *Daily database backup* -> **Run workflow** once. A green run and a file under Storage -> `db-backups` -> `daily/` means it works.

The private bucket `db-backups` is created by the first run. The newest 30 days are kept; older files are deleted by the same job.
The schedule only runs from the default branch (`main`).

## Restoring one store (no new Supabase project needed)
1. Download the newest file from Storage -> `db-backups` -> `daily/`.
2. On any computer with PostgreSQL: `createdb nj_restore && pg_restore --no-owner -d nj_restore njpos-db-....dump`
   (or use a free local Postgres / a throwaway Supabase project).
3. In that restored copy run the same generator queries used before (users/roles/categories, settings): they print a script.
4. Run the printed script in the live project.

## One-click restore of one store (use this instead of the manual steps above)
GitHub -> repository `njpos-owner` -> Actions -> **Build a store restore script from a backup** -> Run workflow:
- *email*: the store owner's email (e.g. `motorpartskkc@gmail.com`)
- *backup_file*: leave empty for the newest backup, or type a file name from Storage -> `db-backups` -> `daily` (pick an older one if the newest was taken after the damage)

When the run is green, open it and download the **restore-script** artifact (it is deleted after one day). Run `restore-script.sql` in the live Supabase project.
It puts back the store's users, roles, categories, branding (name, initials) and settings from the backup, keeps anything newer that the live store has, and never touches orders, products or shifts.
It first saves the live row in a private table `store_data_restore_safety_<date>`.

## Restoring a store's PRODUCTS from a backup
Use this when a store's products were deleted (the restore above never touches products). GitHub -> `njpos-owner` -> Actions -> **Restore a store's products from a backup** -> Run workflow:
- *email*: the store owner's email
- *backup_file*: a file from BEFORE the products were lost (Storage -> `db-backups` -> `daily`; names are in UTC)
- *apply*: first run with **no** (a preview: it only prints a report), then **yes** to restore.

The stock numbers come from the backup, reduced by what the paid orders sold since then (orders that are in the live store but not in the backup). The report lists units sold since, products created after the backup (not restored) and products that would go below zero (shown as 0). Anything received or edited after the backup needs a stock count.
The products are written through the same database function the app uses (`upsert_products`), so every device picks them up on its next sync.

## Early warning and protections (added after the KKC / Ni Bosc incidents)
- **Hourly store health check** (`.github/workflows/store-health-check.yml`): every hour it looks for a store with 50+ orders that has no users or no products. If it finds one the run fails and GitHub emails the repository owner. You can also run it by hand from Actions.
- **Database rule** (`store_data_protect.sql`, run once in Supabase): an update can no longer empty a store's users, wipe 20+ categories, or reset the store name.
- **Product protection** (`delta_safety.sql`, in the njpos-pwa repo's docs/delta-sync.sql): the database refuses to remove most of a store's products at once, and devices keep products that were restored.
- **App protections**: Switch Store downloads the new store first and changes nothing if it fails; a device remembers which store its data belongs to; a device whose product list looks lost re-downloads it instead of deleting the store's products.
