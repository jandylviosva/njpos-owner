// node --test api/_reportSchedule.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { dueNow, parseTime, normTime, addDays, dayOfWeek, reportDays, zonedParts, fmtClock } from "./_reportSchedule.js";

// Philippine Time = UTC+8
const pht = (iso) => Date.parse(iso + "+08:00");

test("time parsing: missing, unreadable and midnight mean the end of the day (11:59 PM)", () => {
  assert.equal(parseTime("21:30"), 1290);
  assert.equal(parseTime("23:59"), 1439);
  assert.equal(parseTime(undefined), 1439);
  assert.equal(parseTime("junk"), 1439);
  assert.equal(parseTime("00:00"), 1439);
  assert.equal(parseTime("00:30"), 30);
  assert.equal(normTime("9:05"), "09:05");
  assert.equal(normTime(undefined), "23:59");
  assert.equal(fmtClock(1439), "11:59 PM"); assert.equal(fmtClock(0), "12:00 AM"); assert.equal(fmtClock(540), "9:00 AM"); assert.equal(fmtClock(720), "12:00 PM"); assert.equal(fmtClock(1290), "9:30 PM");
});
test("dates and weekdays", () => {
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(dayOfWeek("2026-10-31"), 6); // Saturday
  assert.deepEqual(reportDays({ reportDays: "weekdays" }), [1, 2, 3, 4, 5]);
  assert.deepEqual(reportDays({ reportDays: "custom", reportDaysList: [1, 3, "5", 9] }), [1, 3, 5]);
  assert.equal(reportDays({}).length, 7);
});
test("zoned parts use the store's time zone", () => {
  assert.deepEqual(zonedParts(Date.parse("2026-10-30T16:05:00Z"), "Asia/Manila"), { dateKey: "2026-10-31", minutes: 5 });
  assert.deepEqual(zonedParts(Date.parse("2026-10-30T16:05:00Z"), "UTC"), { dateKey: "2026-10-30", minutes: 16 * 60 + 5 });
  assert.equal(zonedParts(Date.parse("2026-10-30T16:05:00Z"), "Not/AZone").dateKey, "2026-10-31"); // bad zone -> Manila
});
test("default (end of day, every day): sent by the 12:00 AM run, covers the whole day, once", () => {
  const os = { reportEnabled: true };
  const d = dueNow(os, pht("2026-10-31T00:20:00"));
  assert.equal(d.due, true);
  assert.equal(d.reportKey, "2026-10-30");        // the day that just ended
  assert.equal(d.todaySoFar, false);              // the whole day, so no "until" in the label
  assert.equal(d.key, "2026-10-30T23:59");
  assert.equal(dueNow({ ...os, lastReportSentKey: d.key }, pht("2026-10-31T00:50:00")).due, false);
  assert.equal(dueNow(os, pht("2026-10-30T23:50:00")).due, false);   // 11:59 PM has not come yet
});
test("a report sent under the old midnight default (it recorded the next day's date) is not sent again", () => {
  assert.equal(dueNow({ lastReportSentDate: "2026-10-31" }, pht("2026-10-31T00:30:00")).due, false);
  assert.equal(dueNow({ lastReportSentDate: "2026-10-30" }, pht("2026-10-31T00:30:00")).due, true);
  assert.equal(dueNow({ lastReportSentDate: "2026-10-31" }, pht("2026-10-31T10:00:00")).due, false);   // too late anyway (3 hour window)
});
test("a store that saved 12:00 AM gets the same end-of-day report", () => {
  const d = dueNow({ reportTime: "00:00" }, pht("2026-10-31T00:10:00"));
  assert.equal(d.reportKey, "2026-10-30"); assert.equal(d.key, "2026-10-30T23:59");
});
test("evening time covers today so far", () => {
  const os = { reportTime: "21:00" };
  assert.equal(dueNow(os, pht("2026-10-31T20:59:00")).due, false);          // not yet (yesterday's 9 PM was sent/too old)
  const d = dueNow(os, pht("2026-10-31T21:10:00"));
  assert.equal(d.due, true); assert.equal(d.reportKey, "2026-10-31"); assert.equal(d.todaySoFar, true);
});
test("a morning time covers today so far too", () => {
  const d = dueNow({ reportTime: "10:30" }, pht("2026-10-31T10:40:00"));
  assert.equal(d.due, true); assert.equal(d.reportKey, "2026-10-31"); assert.equal(d.todaySoFar, true);
});
test("days of the week: custom Mon/Wed/Fri", () => {
  const os = { reportTime: "21:00", reportDays: "custom", reportDaysList: [1, 3, 5] };
  assert.equal(dueNow(os, pht("2026-10-30T21:05:00")).due, true);   // Friday
  assert.equal(dueNow(os, pht("2026-10-31T21:05:00")).due, false);  // Saturday
  assert.equal(dueNow(os, pht("2026-10-26T21:05:00")).due, true);   // Monday
});
test("a run more than 3 hours late skips instead of sending something stale", () => {
  assert.equal(dueNow({ reportTime: "09:00" }, pht("2026-10-31T12:30:00")).due, false);
  assert.equal(dueNow({ reportTime: "09:00" }, pht("2026-10-31T11:30:00")).due, true);
  // turning the report on at 10 AM does not send yesterday's report straight away
  assert.equal(dueNow({ reportEnabled: true }, pht("2026-10-31T10:00:00")).due, false);
});
test("other time zones", () => {
  // 21:00 in Singapore is also UTC+8; 21:00 in UTC is 05:00 next day Manila
  assert.equal(dueNow({ reportTime: "21:00", timezone: "UTC" }, Date.parse("2026-10-31T21:10:00Z")).due, true);
  assert.equal(dueNow({ reportTime: "21:00", timezone: "UTC" }, Date.parse("2026-10-31T20:50:00Z")).due, false);
});
