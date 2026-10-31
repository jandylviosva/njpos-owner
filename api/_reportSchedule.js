// When a store's scheduled daily report is due. The leading underscore keeps Vercel from exposing this file as a route.
//
// A store chooses a time of day (default 11:59 PM, the end of the day) and which days of the week; the time is in the store's time zone
// (order_settings.timezone, default Asia/Manila). The server job runs often (every 30 minutes, or once a day at midnight
// Philippine Time on a plan that only allows one run a day) and sends the reports that have become due since the last
// run, so a late run still sends and nothing is sent twice.
export const DEFAULT_TZ = "Asia/Manila";
export const MAX_LATE_MIN = 3 * 60;    // a run that finds a report more than this late skips it instead of sending something stale
export const END_OF_DAY = "23:59";     // the default send time: the end of the business day

const pad = (n) => String(n).padStart(2, "0");

export const validTz = (tz) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return DEFAULT_TZ; }
};

// "HH:MM" -> minutes since midnight. A missing, unreadable or midnight ("00:00", the old default) time means the end of
// the day, 11:59 PM, so a report at "midnight" is the report of the day that is ending.
export const parseTime = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || "").trim());
  if (!m) return 23 * 60 + 59;
  const mins = Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2]));
  return mins === 0 ? 23 * 60 + 59 : mins;
};
export const normTime = (t) => { const mins = parseTime(t); return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`; };

// The calendar date, minutes since midnight in the given time zone
export const zonedParts = (ms, tz) => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: validTz(tz), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const g = (type) => parts.find((p) => p.type === type)?.value;
  return { dateKey: `${g("year")}-${g("month")}-${g("day")}`, minutes: Number(g("hour")) * 60 + Number(g("minute")) };
};

export const addDays = (dateKey, n) => {
  const [y, m, d] = dateKey.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};
export const dayOfWeek = (dateKey) => { const [y, m, d] = dateKey.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }; // 0 = Sunday

// Which days of the week (0 = Sunday ... 6 = Saturday) the store wants the report
export const reportDays = (os) => {
  if (os?.reportDays === "weekdays") return [1, 2, 3, 4, 5];
  if (os?.reportDays === "custom") return (Array.isArray(os.reportDaysList) ? os.reportDaysList : []).map(Number).filter((n) => n >= 0 && n <= 6);
  return [0, 1, 2, 3, 4, 5, 6];
};

// What the report covers: the sales of the send day up to the send time. At the end-of-day time (11:59 PM) that is the whole
// day, so the label doesn't say "until".
export const coverage = (day, schedMin) => ({ reportKey: day, todaySoFar: schedMin < 23 * 60 + 59 });

// { due:false, reason } or { due:true, key, day, tz, schedMin, reportKey, todaySoFar }
export const dueNow = (os, nowMs = Date.now()) => {
  const tz = validTz(os?.timezone || DEFAULT_TZ);
  const p = zonedParts(nowMs, tz);
  const schedMin = parseTime(os?.reportTime);
  const passed = p.minutes >= schedMin;
  const day = passed ? p.dateKey : addDays(p.dateKey, -1);   // the day whose scheduled time most recently passed
  const lateMin = passed ? p.minutes - schedMin : p.minutes + 1440 - schedMin;
  if (lateMin > MAX_LATE_MIN) return { due: false, reason: "missed" };
  if (!reportDays(os).includes(dayOfWeek(day))) return { due: false, reason: "not a report day" };
  const key = `${day}T${normTime(os?.reportTime)}`;
  if (os?.lastReportSentKey === key) return { due: false, reason: "already sent" };
  // Reports sent when the default was midnight recorded the date of the run, which is the day AFTER the day they covered
  if (normTime(os?.reportTime) === END_OF_DAY && os?.lastReportSentDate === addDays(day, 1)) return { due: false, reason: "already sent" };
  return { due: true, key, day, tz, schedMin, ...coverage(day, schedMin) };
};

// 540 -> "9:00 AM"
export const fmtClock = (mins) => {
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? "AM" : "PM"}`;
};
