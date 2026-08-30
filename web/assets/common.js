/* MoviesAboard viewer — shared runtime.
 *
 * Classic script on purpose (no ES modules, no build step): pages load it
 * with a plain <script> tag, same as /vendor/hls.min.js, and everything
 * works from any bare static server on a LAN with no internet.
 *
 * Exposes a single global: window.MAB.
 */
(function () {
  'use strict';

  var MAB = {};

  /* ---------------- server clock ----------------
   * Offset is computed ONCE per page load and reused:
   *   1. GET /time -> { now } (preferred)
   *   2. else the Date response header of the schedule.json fetch
   *   3. else client Date.now() (offset 0)
   */
  var offsetMs = 0;
  var clockSource = 'client';
  var headerOffsetMs = null; // candidate captured from schedule fetch
  var clockSynced = false;

  MAB.now = function () {
    return Date.now() + offsetMs;
  };

  MAB.clockSource = function () {
    return clockSource;
  };

  MAB.syncClock = function () {
    if (clockSynced) return Promise.resolve(clockSource);
    clockSynced = true;
    var t0 = Date.now();
    return fetch('time', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('time endpoint HTTP ' + res.status);
        return res.json();
      })
      .then(function (body) {
        var t1 = Date.now();
        if (body && typeof body.now === 'number' && isFinite(body.now)) {
          // assume the response reflects the midpoint of the round trip
          offsetMs = body.now - (t0 + t1) / 2;
          clockSource = 'server';
        } else {
          throw new Error('time endpoint: bad body');
        }
        return clockSource;
      })
      .catch(function () {
        if (headerOffsetMs !== null) {
          offsetMs = headerOffsetMs;
          clockSource = 'date-header';
        } else {
          offsetMs = 0;
          clockSource = 'client';
        }
        return clockSource;
      });
  };

  /* ---------------- schedule ---------------- */

  MAB.fetchSchedule = function () {
    var t0 = Date.now();
    return fetch('schedule.json', { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('schedule.json HTTP ' + res.status);
      var dateHdr = res.headers.get('Date');
      if (dateHdr) {
        var parsed = Date.parse(dateHdr);
        if (isFinite(parsed)) {
          // Date headers have 1s granularity; +500ms centers the error.
          headerOffsetMs = parsed + 500 - t0;
        }
      }
      return res.json();
    });
  };

  /* Fetch the schedule, then sync the clock (once). The order matters:
   * the schedule response's Date header is the /time fallback. */
  MAB.init = function () {
    return MAB.fetchSchedule().then(function (schedule) {
      return MAB.syncClock().then(function () {
        return schedule;
      });
    });
  };

  /* ---------------- airing lookup ----------------
   * Airings are sorted; gaps are allowed (off-air). Returns the airing
   * covering `now` (start <= now < end) plus the next one to start.
   */
  MAB.whatsOn = function (channel, now) {
    var list = (channel && channel.airings) || [];
    var current = null;
    var next = null;
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a.start <= now && now < a.end) {
        current = a;
      } else if (a.start > now) {
        next = a;
        break;
      }
    }
    return { current: current, next: next };
  };

  MAB.progressPct = function (airing, now) {
    var span = airing.end - airing.start;
    if (!(span > 0)) return 0;
    var pct = ((now - airing.start) / span) * 100;
    return Math.max(0, Math.min(100, pct));
  };

  /* Resolve an airing src ("content/<slug>/index.m3u8") against the page
   * URL so the viewer also works when served under a subpath. */
  MAB.resolveSrc = function (src) {
    return new URL(src, document.baseURI).href;
  };

  /* ---------------- time formatting ----------------
   * All display times use the station timezone. An invalid/missing
   * timezone falls back to the browser's local zone rather than crashing.
   */
  function makeFmt(opts, tz) {
    var merged = {};
    var k;
    for (k in opts) merged[k] = opts[k];
    if (tz) merged.timeZone = tz;
    try {
      return new Intl.DateTimeFormat(undefined, merged);
    } catch (err) {
      return new Intl.DateTimeFormat(undefined, opts);
    }
  }

  MAB.makeFormats = function (tz) {
    var time = makeFmt({ hour: 'numeric', minute: '2-digit' }, tz);
    var timeDay = makeFmt(
      { weekday: 'short', hour: 'numeric', minute: '2-digit' }, tz);
    var clock = makeFmt(
      { weekday: 'short', hour: 'numeric', minute: '2-digit',
        second: '2-digit' }, tz);
    var day = makeFmt(
      { weekday: 'long', month: 'long', day: 'numeric' }, tz);
    var dayKeyFmt = makeFmt(
      { year: 'numeric', month: '2-digit', day: '2-digit' }, tz);

    function dayKey(ms) {
      var parts = dayKeyFmt.formatToParts(ms);
      var out = { year: '', month: '', day: '' };
      for (var i = 0; i < parts.length; i++) {
        if (out.hasOwnProperty(parts[i].type)) {
          out[parts[i].type] = parts[i].value;
        }
      }
      return out.year + '-' + out.month + '-' + out.day;
    }

    return {
      /* "8:05 PM" */
      time: function (ms) { return time.format(ms); },
      /* "8:05 PM" today, "Fri 8:05 PM" another day */
      timeSmart: function (ms, nowMs) {
        return dayKey(ms) === dayKey(nowMs)
          ? time.format(ms)
          : timeDay.format(ms);
      },
      /* "8:00 PM – 9:30 PM" */
      range: function (a, b) {
        return time.format(a) + '–' + time.format(b);
      },
      /* live header clock: "Thu 8:05:42 PM" */
      clock: function (ms) { return clock.format(ms); },
      /* "Thursday, August 28" */
      day: function (ms) { return day.format(ms); },
      /* stable per-day grouping key, "2026-08-28" in station tz */
      dayKey: dayKey
    };
  };

  /* ---------------- misc ---------------- */

  MAB.escapeHtml = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };

  /* localStorage is a per-viewer convenience only; never required. */
  MAB.storageGet = function (key) {
    try { return window.localStorage.getItem(key); }
    catch (err) { return null; }
  };
  MAB.storageSet = function (key, value) {
    try { window.localStorage.setItem(key, value); }
    catch (err) { /* private mode etc. — fine */ }
  };

  window.MAB = MAB;
}());
