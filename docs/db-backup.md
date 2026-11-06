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
