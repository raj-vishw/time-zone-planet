// Everything drawn in HTML over the canvas: clock, status, sunrise list, "you" chip, scrubber, tooltip.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let regionNames = null;
try { regionNames = new Intl.DisplayNames(['en'], { type: 'region' }); } catch {}
export function countryName(cc) {
  if (!cc) return '';
  try { return regionNames?.of(cc) || cc; } catch { return cc; }
}
export function placeName(p) {
  if (p.city) return `${p.city}${p.country ? ', ' + p.country : ''}`;
  if (p.country) return countryName(p.country);
  return 'Somewhere';
}

const fmt = (n) => n.toLocaleString('en-US');
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function createHud(actions) {
  const el = {
    time: $('clock-time'), date: $('clock-date'), sun: $('sun-point'),
    status: $('status'), statusText: $('status-text'), waking: $('waking'), earlier: $('earlier'), earlierText: $('earlier-text'),
    list: $('sunrise-list'), you: $('you'),
    scrub: $('scrub'), play: $('play'), live: $('live'), when: $('when'), follow: $('follow'),
    tip: $('tip'), panel: $('sunrise'), panelToggle: $('sunrise-toggle'),
  };

  el.scrub.addEventListener('input', () => actions.onScrub(Number(el.scrub.value)));
  el.play.addEventListener('click', () => actions.onPlay());
  el.live.addEventListener('click', () => actions.onLive());
  el.follow.addEventListener('click', () => actions.onFollow());
  el.you.addEventListener('click', () => actions.onFlyYou());
  el.panelToggle.addEventListener('click', () => {
    const open = el.panel.classList.toggle('open');
    el.panelToggle.setAttribute('aria-expanded', String(open));
  });
  el.list.addEventListener('click', (e) => {
    const li = e.target.closest('[data-lat]');
    if (li) actions.onFly(Number(li.dataset.lat), Number(li.dataset.lon));
  });

  let lastClock = '';
  let lastList = '';

  return {
    setStatus(mode, total, countries, waking) {
      el.status.dataset.mode = mode;
      let text;
      if (mode === 'connecting') text = 'Connecting…';
      else if (mode === 'offline') text = 'Offline · only you';
      else if (mode === 'demo') text = `DEMO · ${fmt(total)} simulated · ${countries} countries`;
      else text = `${fmt(total)} online · ${countries} ${countries === 1 ? 'country' : 'countries'}`;
      el.statusText.textContent = text;
      el.waking.textContent = waking > 0 ? `${fmt(waking)} ${waking === 1 ? 'person is' : 'people are'} just waking up` : '';
      el.waking.hidden = waking <= 0;
    },
    setEarlier(places) {
      el.earlierText.textContent = places > 0 ? `${fmt(places)} more ${places === 1 ? 'place' : 'places'} in the last 24 h` : '';
      el.earlier.hidden = places <= 0;
    },
    setReplayStatus(visits, places) {
      el.status.dataset.mode = 'replay';
      el.statusText.textContent = `${fmt(visits)} ${visits === 1 ? 'visit' : 'visits'} this hour · ${places} ${places === 1 ? 'place' : 'places'}`;
      el.waking.hidden = true;
    },
    setClock(ms, offsetH, playing) {
      const d = new Date(ms);
      const hh = String(d.getUTCHours()).padStart(2, '0'), mm = String(d.getUTCMinutes()).padStart(2, '0'), ss = String(d.getUTCSeconds()).padStart(2, '0');
      const key = `${hh}${mm}${ss}${offsetH.toFixed(2)}${playing}`;
      if (key === lastClock) return;
      lastClock = key;
      el.time.textContent = `${hh}:${mm}:${ss}`;
      el.date.textContent = `UTC · ${DAY[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
      const isLive = offsetH === 0 && !playing;
      if (document.activeElement !== el.scrub) el.scrub.value = String(offsetH);
      el.scrub.style.setProperty('--p', `${((offsetH + 24) / 24) * 100}%`);
      el.live.classList.toggle('on', isLive);
      el.live.setAttribute('aria-pressed', String(isLive));
      el.play.textContent = playing ? '❚❚' : '▶';
      el.play.setAttribute('aria-label', playing ? 'Pause replay' : 'Replay the last 24 hours');
      el.when.textContent = isLive ? 'Live' : offsetH > -1 ? `${Math.round(offsetH * 60)} min` : `${offsetH.toFixed(1)} h`;
    },
    setSunPoint(lat, lon) {
      el.sun.textContent = `Sun overhead · ${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
    },
    /** items: [{ lat, lon, name, time, alt, n, visitor }] */
    setSunrise(items, replay) {
      const html = items.length
        ? items.map((it) => `
          <li><button type="button" data-lat="${it.lat}" data-lon="${it.lon}">
            <span class="sr-icon ${it.alt > 0 ? 'up' : 'pre'}" aria-hidden="true"></span>
            <span class="sr-name">${esc(it.name)}</span>
            <span class="sr-time">${esc(it.time)}</span>
            ${it.n ? `<span class="sr-n">${fmt(it.n)} ${replay ? 'visited' : 'here'}</span>` : `<span class="sr-alt">${it.alt > 0 ? 'sunrise' : 'first light'}</span>`}
          </button></li>`).join('')
        : '<li class="empty">The dawn line is crossing open ocean right now.</li>';
      if (html !== lastList) { lastList = html; el.list.innerHTML = html; }
    },
    setYou(p, time) {
      if (!p) { el.you.hidden = true; return; }
      el.you.hidden = false;
      const where = p.approx ? (p.tz ? `${p.tz.split('/').pop().replace(/_/g, ' ')} time zone` : 'your time zone') : placeName(p);
      el.you.innerHTML = `<span class="you-dot" aria-hidden="true"></span><span>You · ${esc(where)} · <b>${esc(time)}</b></span>`;
    },
    setFollow(on) {
      el.follow.classList.toggle('on', on);
      el.follow.setAttribute('aria-pressed', String(on));
    },
    showTip(x, y, html) {
      el.tip.innerHTML = html;
      el.tip.hidden = false;
      const w = el.tip.offsetWidth, h = el.tip.offsetHeight;
      const left = Math.min(window.innerWidth - w - 8, Math.max(8, x + 14));
      const top = y - h - 12 < 8 ? y + 18 : y - h - 12;
      el.tip.style.transform = `translate(${left}px, ${top}px)`;
    },
    hideTip() { el.tip.hidden = true; },
    esc,
  };
}
