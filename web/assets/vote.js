/* MoviesAboard viewer — voting page (vote.html).
 *
 * GET  api/ballot -> { open, slugs: [{ slug, title }], closes }
 * POST api/vote {"slug"} -> { ok, counts: [{ slug, title, votes }] }
 * Either endpoint may 404 — voting is then simply offline.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var fmt = MAB.makeFormats(undefined);
  var ballot = null;
  var counts = null;         // last counts from a vote response
  var votedSlug = MAB.storageGet('mab-vote');
  var posting = false;

  function applyStation(schedule) {
    var st = (schedule && schedule.station) || {};
    if (st.name) {
      $('station-name').textContent = st.name;
      document.title = st.name + ' — Vote';
    }
    fmt = MAB.makeFormats(st.timezone);
  }

  function startClock() {
    window.setInterval(function () {
      $('clock').textContent = fmt.clock(MAB.now());
      renderCountdown();
    }, 500);
  }

  function setStatus(html) {
    $('vote-status').innerHTML = html;
  }

  function renderCountdown() {
    var el = $('countdown');
    if (!el) return;
    if (!ballot || !ballot.open ||
        typeof ballot.closes !== 'number' || !isFinite(ballot.closes)) {
      el.textContent = '';
      return;
    }
    var left = ballot.closes - MAB.now();
    if (left <= 0) {
      el.textContent = 'Voting is closing…';
      return;
    }
    var s = Math.floor(left / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    var t = h > 0
      ? h + 'h ' + m + 'm'
      : m + ':' + (sec < 10 ? '0' : '') + sec;
    el.textContent = 'Closes in ' + t +
      ' (' + fmt.timeSmart(ballot.closes, MAB.now()) + ')';
  }

  function renderBallot() {
    var box = $('ballot');
    if (!ballot) {
      setStatus('Voting is offline right now.');
      box.innerHTML = '';
      return;
    }
    if (!ballot.open) {
      setStatus('Voting is closed. Watch the vote channel to see ' +
        'what won.');
      box.innerHTML = '';
      return;
    }
    setStatus('Pick what airs next on the vote channel.' +
      '<span class="countdown" id="countdown"></span>');
    renderCountdown();

    var slugs = ballot.slugs || [];
    var html = '';
    for (var i = 0; i < slugs.length; i++) {
      var s = slugs[i];
      var mine = votedSlug === s.slug;
      html += '<button type="button" class="vote-btn' +
        (mine ? ' voted' : '') + '" data-slug="' +
        MAB.escapeHtml(s.slug) + '"' + (posting ? ' disabled' : '') + '>' +
        '<span class="marker">' + (mine ? '[X]' : '[ ]') + '</span>' +
        '<span>' + MAB.escapeHtml(s.title) + '</span>' +
        '</button>';
    }
    box.innerHTML = html ||
      '<p class="page-note">The ballot is empty.</p>';
  }

  function renderCounts() {
    var box = $('results');
    if (!counts || !counts.length) {
      box.innerHTML = '';
      return;
    }
    var max = 0;
    var total = 0;
    var i;
    for (i = 0; i < counts.length; i++) {
      max = Math.max(max, counts[i].votes || 0);
      total += counts[i].votes || 0;
    }
    var html = '<h2>Standings · ' + total +
      (total === 1 ? ' vote' : ' votes') + '</h2>';
    for (i = 0; i < counts.length; i++) {
      var c = counts[i];
      var pct = max > 0 ? ((c.votes || 0) / max) * 100 : 0;
      html += '<div class="result-row">' +
        '<div class="r-head"><span>' + MAB.escapeHtml(c.title) +
        (votedSlug === c.slug ? '<span class="chip-now">YOURS</span>' : '') +
        '</span>' +
        '<span class="r-votes">' + (c.votes || 0) + '</span></div>' +
        '<div class="r-bar"><span style="width:' + pct.toFixed(1) +
        '%"></span></div>' +
        '</div>';
    }
    box.innerHTML = html;
  }

  /* A stable random id per browser so viewers behind one address (or two
   * tabs on one machine) count as distinct voters. Falls back to a
   * per-page id when localStorage is unavailable — still one voter per
   * tab, never a shared one. */
  var pageVoterId = null;
  function voterId() {
    var id = MAB.storageGet('mab-voter') || pageVoterId;
    if (!id) {
      id = 'v-' + Math.random().toString(36).slice(2, 10) +
        Date.now().toString(36);
      pageVoterId = id;
      MAB.storageSet('mab-voter', id);
    }
    return id;
  }

  function castVote(slug) {
    if (posting) return;
    posting = true;
    renderBallot();
    fetch('api/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: slug, voter: voterId() })
    }).then(function (res) {
      if (!res.ok) throw new Error('vote HTTP ' + res.status);
      return res.json();
    }).then(function (body) {
      posting = false;
      if (body && body.ok) {
        votedSlug = slug;
        MAB.storageSet('mab-vote', slug);
        counts = body.counts || null;
      }
      renderBallot();
      renderCounts();
    }).catch(function () {
      posting = false;
      renderBallot();
      setStatus('That vote did not go through — voting may have ' +
        'just closed. Try again.');
    });
  }

  function fetchBallot() {
    return fetch('api/ballot', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('ballot HTTP ' + res.status);
        return res.json();
      })
      .then(function (body) {
        ballot = body;
        renderBallot();
      })
      .catch(function () {
        ballot = null;
        renderBallot();
      });
  }

  function bindUi() {
    $('ballot').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-slug]');
      if (btn && !btn.disabled) {
        castVote(btn.getAttribute('data-slug'));
      }
    });
  }

  function boot() {
    // Station name + server clock come from the schedule; voting still
    // works (with the client clock) if that fetch fails.
    MAB.init().then(function (schedule) {
      applyStation(schedule);
    }).catch(function () {
      return MAB.syncClock();
    }).then(function () {
      startClock();
      bindUi();
      fetchBallot();
      window.setInterval(fetchBallot, 30 * 1000);
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) fetchBallot();
      });
    });
  }

  boot();
}());
