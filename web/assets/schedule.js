/* MoviesAboard viewer — full weekly schedule (schedule.html).
 * Readable per channel, per day, in the station timezone.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var schedule = null;
  var fmt = MAB.makeFormats(undefined);
  var GAP_MIN_MS = 60 * 1000;
  /* One day rendered at a time: a full packed week is tens of thousands
   * of airings, far too many DOM rows to build (and rebuild every
   * refetch). dayKey of the day being shown; null = not chosen yet. */
  var selectedDay = null;

  /* Ordered unique [{ key, label }] over every airing's start day. */
  function dayList() {
    var seen = {};
    var days = [];
    var chans = (schedule && schedule.channels) || [];
    for (var c = 0; c < chans.length; c++) {
      var airings = chans[c].airings || [];
      for (var i = 0; i < airings.length; i++) {
        var key = fmt.dayKey(airings[i].start);
        if (!seen[key]) {
          seen[key] = true;
          days.push({ key: key, label: fmt.day(airings[i].start) });
        }
      }
    }
    days.sort(function (a, b) {
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    return days;
  }

  function renderDayTabs(days) {
    var html = '';
    for (var i = 0; i < days.length; i++) {
      var d = days[i];
      html += '<a href="#" data-day="' + MAB.escapeHtml(d.key) + '"' +
        (d.key === selectedDay ? ' class="active"' : '') + '>' +
        MAB.escapeHtml(d.label) + '</a>';
    }
    $('day-tabs').innerHTML = html;
  }

  function applyStation() {
    var st = (schedule && schedule.station) || {};
    if (st.name) {
      $('station-name').textContent = st.name;
      document.title = st.name + ' — Schedule';
    }
    fmt = MAB.makeFormats(st.timezone);
  }

  function startClock() {
    window.setInterval(function () {
      $('clock').textContent = fmt.clock(MAB.now());
    }, 500);
  }

  function gapRow(fromMs, toMs) {
    return '<tr class="gap-row">' +
      '<td class="t-time">' +
      MAB.escapeHtml(fmt.range(fromMs, toMs)) + '</td>' +
      '<td class="t-title">off air</td>' +
      '</tr>';
  }

  function airingRow(a, now) {
    var isNow = a.start <= now && now < a.end;
    return '<tr class="' + (isNow ? 'now-row' : '') + '">' +
      '<td class="t-time">' +
      MAB.escapeHtml(fmt.range(a.start, a.end)) + '</td>' +
      '<td class="t-title">' + MAB.escapeHtml(a.title) +
      (a.live ? '<span class="badge-live">LIVE</span>' : '') +
      (isNow ? '<span class="chip-now">NOW</span>' : '') +
      '</td></tr>';
  }

  function render() {
    if (!schedule) return;
    var now = MAB.now();
    var days = dayList();
    if (!days.length) {
      $('day-tabs').innerHTML = '';
      $('chan-jump').innerHTML = '';
      $('sched-body').innerHTML =
        '<p class="page-note">Nothing scheduled.</p>';
      $('notice').classList.add('hidden');
      return;
    }
    // Default to today when it is on the schedule; keep a still-valid
    // selection across refetches.
    var valid = days.some(function (d) { return d.key === selectedDay; });
    if (!valid) {
      var today = fmt.dayKey(now);
      selectedDay = days.some(function (d) { return d.key === today; })
        ? today
        : days[0].key;
    }
    renderDayTabs(days);

    var chans = (schedule.channels || []).slice().sort(function (a, b) {
      return a.num - b.num;
    });

    var jump = '';
    var body = '';

    for (var c = 0; c < chans.length; c++) {
      var ch = chans[c];
      var anchor = 'ch-' + ch.num;
      jump += '<a href="#' + anchor + '"><b>' + ch.num + '</b>' +
        MAB.escapeHtml(ch.name) + '</a>';

      body += '<section class="sched-channel" id="' + anchor + '">' +
        '<div class="sched-chan-head">' +
        '<div class="g-num">' + ch.num + '</div>' +
        '<div class="g-name">' + MAB.escapeHtml(ch.name) + '</div>' +
        '</div>';

      // Only the selected day's airings become DOM rows (an airing
      // belongs to the day it starts on, like the planner's contract).
      var airings = (ch.airings || []).filter(function (a) {
        return fmt.dayKey(a.start) === selectedDay;
      });
      if (!airings.length) {
        body += '<p class="page-note">Nothing scheduled this day.</p>' +
          '</section>';
        continue;
      }

      body += '<div class="sched-day">' +
        '<table class="sched-table"><tbody>';
      for (var i = 0; i < airings.length; i++) {
        var a = airings[i];
        body += airingRow(a, now);
        // Mark off-air gaps between consecutive airings.
        var b = airings[i + 1];
        if (b && b.start - a.end >= GAP_MIN_MS) {
          body += gapRow(a.end, b.start);
        }
      }
      body += '</tbody></table></div></section>';
    }

    $('chan-jump').innerHTML = jump;
    $('sched-body').innerHTML = body;
    $('notice').classList.add('hidden');
  }

  function refetch() {
    MAB.fetchSchedule().then(function (fresh) {
      schedule = fresh;
      applyStation();
      render();
    }).catch(function () {
      // keep showing the last good render
    });
  }

  function bindDayTabs() {
    $('day-tabs').addEventListener('click', function (e) {
      var link = e.target.closest('[data-day]');
      if (!link) return;
      e.preventDefault();
      selectedDay = link.getAttribute('data-day');
      render();
    });
  }

  function boot() {
    MAB.init().then(function (s) {
      schedule = s;
      applyStation();
      startClock();
      render();
      window.setInterval(refetch, 60 * 1000);
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) refetch();
      });
    }).catch(function () {
      var n = $('notice');
      n.textContent = 'Cannot load the schedule. Retrying…';
      n.className = 'notice error';
      window.setTimeout(boot, 5000);
    });
  }

  bindDayTabs(); // once — boot() may retry after a failed load
  boot();
}());
