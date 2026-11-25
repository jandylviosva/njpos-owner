// Starts the "Database backup" GitHub workflow on time.
//
// GitHub's own scheduler delays and skips runs (we saw 2-3 backups a day instead of 8), while Vercel's cron runs on
// the minute. The backup itself (pg_dump) still runs in GitHub Actions; this only presses its "Run workflow" button.
//
// Needs two Vercel environment variables:
//   GITHUB_BACKUP_TOKEN  fine-grained GitHub token, repository "njpos-owner" only, permission "Actions: Read and write"
//   CRON_SECRET          (already used by /api/daily-report) so only Vercel's cron can call this
const REPO = "jandylviosva/njpos-owner";
const WORKFLOW = "db-backup.yml";
const REF = "main";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const secret = process.env.CRON_SECRET;
  const auth = String(req.headers?.authorization || "");
  const isCron = secret
    ? auth === `Bearer ${secret}`
    : String(req.headers?.["user-agent"] || "").startsWith("vercel-cron") || req.headers?.["x-vercel-cron"] === "1";
  if (!isCron) return res.status(403).json({ error: "Forbidden" });

  const token = process.env.GITHUB_BACKUP_TOKEN;
  if (!token) return res.status(500).json({ error: "GITHUB_BACKUP_TOKEN is not set in Vercel" });

  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "njpos-backup-trigger",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: REF }),
    });
    if (r.status !== 204) {
      const text = await r.text().catch(() => "");
      console.error(`[trigger-backup] GitHub answered ${r.status}: ${text.slice(0, 300)}`);
      return res.status(502).json({ error: `GitHub answered ${r.status}` });
    }
    return res.status(200).json({ ok: true, started: new Date().toISOString() });
  } catch (e) {
    console.error("[trigger-backup] failed:", e?.message || e);
    return res.status(502).json({ error: "Could not reach GitHub" });
  }
}
