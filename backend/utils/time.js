'use strict';
// Date helpers pinned to the college's time zone (default India), so "today" and
// "past appointment" do not depend on where the server happens to run.
const TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';

function parts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  return Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
}

const today = (date) => { const p = parts(date); return `${p.year}-${p.month}-${p.day}`; };
const nowTime = (date) => { const p = parts(date); return `${p.hour}:${p.minute}`; };

/** YYYY-MM-DD that is `days` after today (college time zone). */
function addDays(days, date = new Date()) {
  const d = new Date(`${today(date)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** True when `value` is a real calendar date in YYYY-MM-DD form. */
function isRealDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

module.exports = { TZ, today, nowTime, addDays, isRealDate };
