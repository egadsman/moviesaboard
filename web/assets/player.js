/* MoviesAboard viewer — guide + player (index.html).
 *
 * The whole point: you join a program in the middle, like real TV.
 * Tuning a channel finds the airing where start <= serverNow < end,
 * plays its HLS src, and seeks to (serverNow - start) seconds. No pause,
 * no scrub bar — volume, mute, and fullscreen only.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var video = $('tv');
  var wrap = $('player-wrap');
  var offairEl = $('offair');
  var bannerEl = $('banner');
  var digitsEl = $('digits');
  var unmuteBtn = $('unmute');
  var tapPlayBtn = $('tapplay');
  var muteBtn = $('mute-btn');
  var volSlider = $('vol');
  var fsBtn = $('fs-btn');
  var guideEl = $('guide-rows');
  var clockEl = $('clock');
  var stationEl = $('station-name');
  var noticeEl = $('notice');

  var schedule = null;
  var fmt = MAB.makeFormats(undefined);
  var activeNum = null;       // channel number we are tuned to
  var playing = null;         // { num, slug, start, end, src } or null
  var hls = null;             // active Hls instance, if any
  var advanceTimer = null;    // fires at end of current airing / gap check
  var endedEarly = null;      // { slug, start } when content ran short
  var bannerTimer = null;
  var digitBuffer = '';
  var digitTimer = null;
  var refetchInFlight = false;

  var SCHEDULE_REFRESH_MS = 60 * 1000;
  var GUIDE_RENDER_MS = 10 * 1000;
  var OFFAIR_RECHECK_MS = 30 * 1000;
  var BANNER_MS = 4000;
  var DIGIT_COMMIT_MS = 1500;

  /* ---------------- helpers ---------------- */

  function channels() {
    return (schedule && schedule.channels) || [];
  }

  function channelByNum(num) {
    var list = channels();
    for (var i = 0; i < list.length; i++) {
      if (list[i].num === num) return list[i];
    }
    return null;
  }

  function sortedNums() {
    return channels()
      .map(function (c) { return c.num; })
      .sort(function (a, b) { return a - b; });
  }

  function showNotice(msg, isError) {
    noticeEl.textContent = msg;
    noticeEl.className = 'notice' + (isError ? ' error' : '');
    noticeEl.classList.remove('hidden');
  }

  function hideNotice() {
    noticeEl.classList.add('hidden');
  }

  /* ---------------- playback ---------------- */

  function destroyPlayback() {
    if (hls) {
      try { hls.destroy(); } catch (err) { /* already dead */ }
      hls = null;
    }
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
    } catch (err) { /* ignore */ }
    playing = null;
  }

  function tryPlay() {
    var p = video.play();
    if (p && typeof p.catch === 'function') {
      p.then(function () {
        tapPlayBtn.classList.add('hidden');
      }).catch(function () {
        // Autoplay blocked even muted: ask for one tap.
        tapPlayBtn.classList.remove('hidden');
      });
    }
  }

  function seekOffsetSeconds(airing) {
    if (airing.live) return null; // live: stay at the live edge
    return Math.max(0, (MAB.now() - airing.start) / 1000);
  }

  function startHls(src, offset) {
    hls = new window.Hls({
      startPosition: offset === null ? -1 : offset
    });
    hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
      tryPlay();
    });
    hls.on(window.Hls.Events.ERROR, function (evt, data) {
      if (!data || !data.fatal) return;
      if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        try { hls.recoverMediaError(); } catch (err) { retuneSoon(); }
      } else {
        retuneSoon();
      }
    });
    hls.loadSource(src);
    hls.attachMedia(video);
    if (offset !== null) {
      // Belt and braces across hls.js versions: verify the start
      // position once metadata is in, then leave currentTime alone.
      video.addEventListener('loadedmetadata', function onMeta() {
        video.removeEventListener('loadedmetadata', onMeta);
        if (Math.abs(video.currentTime - offset) > 2) {
          try { video.currentTime = offset; } catch (err) { /* ignore */ }
        }
      });
    }
  }

  function startNative(src, offset) {
    video.addEventListener('loadedmetadata', function onMeta() {
      video.removeEventListener('loadedmetadata', onMeta);
      if (offset !== null) {
        var target = offset;
        if (isFinite(video.duration) && video.duration > 1) {
          target = Math.min(target, video.duration - 0.5);
        }
        try { video.currentTime = target; } catch (err) { /* ignore */ }
      }
      tryPlay();
    });
    video.src = src;
  }

  function retuneSoon() {
    // Fatal player error: destroy and retry the channel in a few seconds.
    var num = activeNum;
    destroyPlayback();
    window.setTimeout(function () {
      if (activeNum === num) tune(num, { osd: false });
    }, 3000);
  }

  function play(channel, airing) {
    destroyPlayback();
    endedEarly = null;
    offairEl.classList.add('hidden');
    var src = MAB.resolveSrc(airing.src);
    var offset = seekOffsetSeconds(airing);
    playing = {
      num: channel.num,
      slug: airing.slug,
      start: airing.start,
      end: airing.end,
      src: airing.src
    };
    if (window.Hls && window.Hls.isSupported()) {
      startHls(src, offset);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      startNative(src, offset);
    } else {
      playing = null;
      showOffAirCard(channel, null,
        'This browser cannot play HLS video.');
    }
  }

  /* ---------------- off air / up next ---------------- */

  /* Shown when the content ran shorter than its scheduled slot: hold a
   * card until the slot ends instead of replaying the tail. */
  function showUpNextCard(channel, airing) {
    destroyPlayback();
    offairEl.classList.remove('hidden');
    $('offair-ch').textContent =
      'CH ' + channel.num + ' · ' + channel.name;
    $('offair-title').textContent = 'Up Next';
    var next = nextAfter(channel, airing);
    var nextEl = $('offair-next');
    if (next) {
      nextEl.innerHTML = '<strong>' + MAB.escapeHtml(next.title) +
        '</strong> at ' +
        MAB.escapeHtml(fmt.timeSmart(next.start, MAB.now()));
    } else {
      nextEl.textContent = '';
    }
  }

  function showOffAirCard(channel, next, customMsg) {
    destroyPlayback();
    offairEl.classList.remove('hidden');
    $('offair-ch').textContent =
      'CH ' + channel.num + ' · ' + channel.name;
    $('offair-title').textContent = customMsg ? '' : 'Off Air';
    var nextEl = $('offair-next');
    if (customMsg) {
      nextEl.textContent = customMsg;
    } else if (next) {
      nextEl.innerHTML = 'Next: <strong>' +
        MAB.escapeHtml(next.title) + '</strong> at ' +
        MAB.escapeHtml(fmt.timeSmart(next.start, MAB.now()));
    } else {
      nextEl.textContent = 'Nothing scheduled on this channel.';
    }
  }

  /* ---------------- tuning ---------------- */

  function clearAdvance() {
    if (advanceTimer !== null) {
      window.clearTimeout(advanceTimer);
      advanceTimer = null;
    }
  }

  function armAdvance(delayMs) {
    clearAdvance();
    var num = activeNum;
    advanceTimer = window.setTimeout(function () {
      advanceTimer = null;
      if (activeNum === num) tune(num, { osd: true });
    }, Math.max(1000, delayMs));
  }

  function tune(num, opts) {
    opts = opts || {};
    var channel = channelByNum(num);
    if (!channel) {
      flashDigits('No channel ' + num);
      return;
    }
    activeNum = num;
    MAB.storageSet('mab-channel', String(num));
    clearAdvance();

    var now = MAB.now();
    var on = MAB.whatsOn(channel, now);

    if (on.current) {
      var ranShort = endedEarly &&
        endedEarly.slug === on.current.slug &&
        endedEarly.start === on.current.start;
      if (ranShort) {
        // Content finished before its slot did; hold the card.
        showUpNextCard(channel, on.current);
        armAdvance(on.current.end - now + 300);
        renderGuide();
        return;
      }
      var same = playing &&
        playing.num === channel.num &&
        playing.slug === on.current.slug &&
        playing.start === on.current.start &&
        playing.src === on.current.src;
      if (!same) play(channel, on.current);
      if (opts.osd !== false) showBanner(channel, on.current);
      armAdvance(on.current.end - now + 300);
    } else {
      showOffAirCard(channel, on.next);
      if (opts.osd !== false && opts.manual) showBanner(channel, null);
      // Re-check when the next airing starts, else periodically.
      armAdvance(on.next
        ? on.next.start - now + 300
        : OFFAIR_RECHECK_MS);
    }
    renderGuide();
  }

  function channelStep(dir) {
    var nums = sortedNums();
    if (!nums.length) return;
    var idx = nums.indexOf(activeNum);
    if (idx === -1) { tune(nums[0], { manual: true }); return; }
    var next = nums[(idx + dir + nums.length) % nums.length];
    tune(next, { manual: true });
  }

  /* After a schedule refetch: keep playing if the current program is
   * unchanged; otherwise retune the active channel. */
  function validatePlayback() {
    if (activeNum === null) { autoTune(); return; }
    var channel = channelByNum(activeNum);
    if (!channel) { activeNum = null; autoTune(); return; }
    var on = MAB.whatsOn(channel, MAB.now());
    var same = on.current && playing &&
      playing.slug === on.current.slug &&
      playing.start === on.current.start &&
      playing.src === on.current.src;
    if (same) {
      // end time may have moved; re-arm the advance timer
      armAdvance(on.current.end - MAB.now() + 300);
      return;
    }
    if (!on.current && !playing) {
      // still off air: refresh the card quietly
      showOffAirCard(channel, on.next);
      armAdvance(on.next
        ? on.next.start - MAB.now() + 300
        : OFFAIR_RECHECK_MS);
      return;
    }
    tune(activeNum, { osd: true });
  }

  function autoTune() {
    var remembered = parseInt(MAB.storageGet('mab-channel') || '', 10);
    if (isFinite(remembered) && channelByNum(remembered)) {
      tune(remembered, { osd: true, manual: true });
      return;
    }
    // First channel with something on now, else the first channel.
    var nums = sortedNums();
    var now = MAB.now();
    for (var i = 0; i < nums.length; i++) {
      var ch = channelByNum(nums[i]);
      if (MAB.whatsOn(ch, now).current) {
        tune(nums[i], { osd: true, manual: true });
        return;
      }
    }
    if (nums.length) tune(nums[0], { osd: true, manual: true });
    else showNotice('The schedule has no channels yet.', false);
  }

  /* ---------------- OSD ---------------- */

  function showBanner(channel, airing) {
    $('osd-num').textContent = channel.num;
    $('osd-ch-name').textContent = channel.name;
    if (airing) {
      $('osd-title').textContent = airing.title +
        (airing.live ? ' · LIVE' : '');
      $('osd-time').textContent = fmt.range(airing.start, airing.end);
    } else {
      $('osd-title').textContent = 'Off Air';
      $('osd-time').textContent = '';
    }
    bannerEl.classList.remove('hidden');
    if (bannerTimer !== null) window.clearTimeout(bannerTimer);
    bannerTimer = window.setTimeout(function () {
      bannerTimer = null;
      bannerEl.classList.add('hidden');
    }, BANNER_MS);
  }

  function flashDigits(msg) {
    digitsEl.textContent = msg;
    digitsEl.classList.add('osd-error');
    digitsEl.classList.remove('hidden');
    if (digitTimer !== null) window.clearTimeout(digitTimer);
    digitTimer = window.setTimeout(function () {
      digitTimer = null;
      digitsEl.classList.add('hidden');
      digitsEl.classList.remove('osd-error');
    }, 1600);
  }

  function pushDigit(d) {
    if (digitBuffer.length >= 4) digitBuffer = '';
    digitBuffer += d;
    digitsEl.textContent = digitBuffer;
    digitsEl.classList.remove('osd-error');
    digitsEl.classList.remove('hidden');
    if (digitTimer !== null) window.clearTimeout(digitTimer);
    digitTimer = window.setTimeout(commitDigits, DIGIT_COMMIT_MS);
  }

  function commitDigits() {
    if (digitTimer !== null) {
      window.clearTimeout(digitTimer);
      digitTimer = null;
    }
    if (!digitBuffer) return;
    var num = parseInt(digitBuffer, 10);
    digitBuffer = '';
    digitsEl.classList.add('hidden');
    if (channelByNum(num)) tune(num, { manual: true });
    else flashDigits('No channel ' + num);
  }

  /* ---------------- guide ---------------- */

  function renderGuide() {
    if (!schedule) return;
    var now = MAB.now();
    var html = '';
    var list = channels().slice().sort(function (a, b) {
      return a.num - b.num;
    });
    for (var i = 0; i < list.length; i++) {
      var ch = list[i];
      var on = MAB.whatsOn(ch, now);
      var nowCell;
      var nextCell;

      if (on.current) {
        nowCell =
          '<div class="g-label">NOW</div>' +
          '<div class="g-title">' + MAB.escapeHtml(on.current.title) +
          (on.current.live ? '<span class="badge-live">LIVE</span>' : '') +
          '</div>' +
          '<div class="g-time">' +
          MAB.escapeHtml(fmt.range(on.current.start, on.current.end)) +
          '</div>' +
          '<div class="g-progress"><span style="width:' +
          MAB.progressPct(on.current, now).toFixed(1) +
          '%"></span></div>';
      } else {
        nowCell =
          '<div class="g-label">NOW</div>' +
          '<div class="g-title g-offair">Off air</div>';
      }

      var upNext = on.current
        ? nextAfter(ch, on.current)
        : on.next;
      if (upNext) {
        nextCell =
          '<div class="g-label">NEXT</div>' +
          '<div class="g-title">' + MAB.escapeHtml(upNext.title) +
          '</div>' +
          '<div class="g-time">' +
          MAB.escapeHtml(fmt.timeSmart(upNext.start, now)) +
          '</div>';
      } else {
        nextCell =
          '<div class="g-label">NEXT</div>' +
          '<div class="g-title g-offair">Off air</div>';
      }

      html +=
        '<div class="guide-row' +
        (ch.num === activeNum ? ' active' : '') +
        '" data-num="' + ch.num + '" role="button" tabindex="0">' +
        '<div class="g-num">' + ch.num + '</div>' +
        '<div class="g-name">' + MAB.escapeHtml(ch.name) + '</div>' +
        '<div class="g-now">' + nowCell + '</div>' +
        '<div class="g-next">' + nextCell + '</div>' +
        '</div>';
    }
    guideEl.innerHTML = html;
  }

  function nextAfter(channel, airing) {
    var list = channel.airings || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].start >= airing.end) return list[i];
    }
    return null;
  }

  /* ---------------- schedule refresh ---------------- */

  function refetch() {
    if (refetchInFlight) return;
    refetchInFlight = true;
    MAB.fetchSchedule().then(function (fresh) {
      refetchInFlight = false;
      schedule = fresh;
      applyStation();
      hideNotice();
      renderGuide();
      validatePlayback();
    }).catch(function () {
      refetchInFlight = false;
      // Keep playing from the last good schedule; just note it.
      showNotice('Schedule refresh failed — showing the last ' +
        'known schedule.', true);
    });
  }

  function applyStation() {
    var st = (schedule && schedule.station) || {};
    if (st.name) {
      stationEl.textContent = st.name;
      document.title = st.name;
    }
    fmt = MAB.makeFormats(st.timezone);
  }

  /* ---------------- controls ---------------- */

  function updateMuteUi() {
    var muted = video.muted || video.volume === 0;
    muteBtn.textContent = muted ? 'UNMUTE' : 'MUTE';
    volSlider.value = String(video.volume);
    if (video.muted) unmuteBtn.classList.remove('hidden');
    else unmuteBtn.classList.add('hidden');
  }

  function toggleFullscreen() {
    var d = document;
    if (d.fullscreenElement || d.webkitFullscreenElement) {
      if (d.exitFullscreen) d.exitFullscreen();
      else if (d.webkitExitFullscreen) d.webkitExitFullscreen();
    } else {
      if (wrap.requestFullscreen) wrap.requestFullscreen();
      else if (wrap.webkitRequestFullscreen) wrap.webkitRequestFullscreen();
    }
  }

  function bindUi() {
    unmuteBtn.addEventListener('click', function () {
      video.muted = false;
      if (video.volume === 0) video.volume = 1;
      updateMuteUi();
      tryPlay();
    });
    tapPlayBtn.addEventListener('click', function () {
      tapPlayBtn.classList.add('hidden');
      tryPlay();
    });
    muteBtn.addEventListener('click', function () {
      video.muted = !video.muted;
      updateMuteUi();
    });
    volSlider.addEventListener('input', function () {
      video.volume = Number(volSlider.value);
      if (video.volume > 0) video.muted = false;
      updateMuteUi();
    });
    fsBtn.addEventListener('click', toggleFullscreen);
    video.addEventListener('volumechange', updateMuteUi);

    // Content shorter than its slot: wait quietly for the slot to end
    // (the advance timer is already armed for airing end).
    video.addEventListener('ended', function () {
      if (!playing || activeNum === null) return;
      var channel = channelByNum(activeNum);
      if (!channel) return;
      var on = MAB.whatsOn(channel, MAB.now());
      if (on.current && on.current.slug === playing.slug &&
          on.current.start === playing.start) {
        endedEarly = { slug: on.current.slug, start: on.current.start };
        showUpNextCard(channel, on.current);
      } else {
        tune(activeNum, { osd: true });
      }
    });

    // Native (non-hls.js) playback errors: retry the channel.
    video.addEventListener('error', function () {
      if (playing && !hls) retuneSoon();
    });

    // Guide: click / keyboard-activate a row to tune.
    guideEl.addEventListener('click', function (e) {
      var row = e.target.closest('[data-num]');
      if (row) tune(parseInt(row.getAttribute('data-num'), 10),
        { manual: true });
    });
    guideEl.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var row = e.target.closest('[data-num]');
      if (row) {
        e.preventDefault();
        tune(parseInt(row.getAttribute('data-num'), 10), { manual: true });
      }
    });

    // Remote-control keys.
    document.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key >= '0' && e.key <= '9') {
        pushDigit(e.key);
        e.preventDefault();
      } else if (e.key === 'Enter' && digitBuffer) {
        commitDigits();
        e.preventDefault();
      } else if (e.key === 'ArrowUp') {
        channelStep(1);
        e.preventDefault();
      } else if (e.key === 'ArrowDown') {
        channelStep(-1);
        e.preventDefault();
      } else if (e.key === 'm' || e.key === 'M') {
        video.muted = !video.muted;
        updateMuteUi();
      } else if (e.key === 'f' || e.key === 'F') {
        toggleFullscreen();
      }
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refetch();
    });
  }

  /* ---------------- clock ---------------- */

  function startClock() {
    window.setInterval(function () {
      clockEl.textContent = fmt.clock(MAB.now());
    }, 500);
  }

  /* ---------------- boot ---------------- */

  function boot() {
    MAB.init().then(function (s) {
      schedule = s;
      applyStation();
      hideNotice();
      bindUi();
      startClock();
      renderGuide();
      updateMuteUi();
      autoTune();
      window.setInterval(refetch, SCHEDULE_REFRESH_MS);
      window.setInterval(renderGuide, GUIDE_RENDER_MS);
    }).catch(function () {
      showNotice('Cannot load the schedule. Retrying…', true);
      window.setTimeout(boot, 5000);
    });
  }

  boot();
}());
