// Vægt Tracker v2 — lokal vægt-logning med mål, tempo (kg/uge) og påmindelser.
// Al data gemmes i localStorage. Ingen server.

const ENTRIES_KEY = 'vaegt-tracker-v1';
const SETTINGS_KEY = 'vaegt-settings-v1';

// --- Data layer -----------------------------------------------------------

function loadEntries() {
  try {
    const raw = localStorage.getItem(ENTRIES_KEY);
    const data = raw ? JSON.parse(raw) : [];
    return Array.isArray(data) ? data.sort((a, b) => a.date.localeCompare(b.date)) : [];
  } catch {
    return [];
  }
}
function saveEntries(entries) { localStorage.setItem(ENTRIES_KEY, JSON.stringify(entries)); }

function upsertEntry(date, kg) {
  const entries = loadEntries();
  const existing = entries.find(e => e.date === date);
  if (existing) existing.kg = kg;
  else entries.push({ date, kg });
  saveEntries(entries);
  return entries;
}
function deleteEntry(date) {
  const entries = loadEntries().filter(e => e.date !== date);
  saveEntries(entries);
  return entries;
}

const DEFAULT_SETTINGS = {
  goalKg: null, reminderEnabled: false, reminderTime: '07:30',
  heightCm: null, strategy: 'maintain', desiredRate: 0,
};
const STRATEGY_DEFAULT_RATE = { cut: -0.5, maintain: 0, gain: 0.25 };
function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

// --- Date helpers ----------------------------------------------------------

function pad(n) { return String(n).padStart(2, '0'); }
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const DAYS = ['Søn', 'Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
function parseISO(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); }
function formatDate(iso) { const d = parseISO(iso); return `${d.getDate()}. ${MONTHS[d.getMonth()]}`; }
function dayName(iso) { return DAYS[parseISO(iso).getDay()]; }
function daysBetween(a, b) { return Math.round((parseISO(b) - parseISO(a)) / 86400000); }
function shiftDate(iso, delta) {
  const d = parseISO(iso); d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// --- Stats -----------------------------------------------------------------

function fmtKg(n) { return n.toLocaleString('da-DK', { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
function fmtSigned(n) {
  const s = n.toLocaleString('da-DK', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return (n > 0 ? '+' : n < 0 ? '−' : '') + s.replace('-', '');
}

/** Rolling 7-day average ending on endDate (entries within 7 days). */
function rolling7Avg(entries, endDate) {
  if (!entries.length) return null;
  const end = endDate || entries[entries.length - 1].date;
  const window = entries.filter(e => { const d = daysBetween(e.date, end); return d >= 0 && d < 7; });
  if (!window.length) return null;
  return window.reduce((s, e) => s + e.kg, 0) / window.length;
}

/** Weekly rate (kg/uge) via linear regression over the last `days` days. */
function weeklyRate(entries, days = 14) {
  if (entries.length < 2) return null;
  const end = parseISO(entries[entries.length - 1].date).getTime();
  const recent = entries.filter(e => (end - parseISO(e.date).getTime()) / 86400000 < days);
  if (recent.length < 2) return null;
  const x0 = parseISO(recent[0].date).getTime();
  let n = 0, sx = 0, sy = 0, sxy = 0, sxx = 0;
  recent.forEach(e => {
    const x = (parseISO(e.date).getTime() - x0) / 86400000;
    const y = e.kg;
    n++; sx += x; sy += y; sxy += x * y; sxx += x * x;
  });
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  return ((n * sxy - sx * sy) / denom) * 7; // kg per week
}

// --- Rendering -------------------------------------------------------------

let currentRange = 30;

function render() {
  const entries = loadEntries();
  const settings = loadSettings();
  renderEntryState(entries);
  renderStats(entries);
  renderBMI(entries, settings);
  renderGoal(entries, settings);
  renderGuidanceWeight();
  renderHistory(entries);
  renderChart(entries, settings);
  renderStreak(entries);
  renderReminderBanner(entries, settings);
}

function renderStreak(entries) {
  const el = document.getElementById('streak');
  if (!entries.length) { el.textContent = 'Daglig tracking'; return; }
  // count consecutive days back from today (or latest)
  let streak = 0;
  let cursor = todayISO();
  const has = new Set(entries.map(e => e.date));
  if (!has.has(cursor)) cursor = shiftDate(cursor, -1); // allow yesterday as still-active
  while (has.has(cursor)) { streak++; cursor = shiftDate(cursor, -1); }
  el.textContent = streak > 1 ? `🔥 ${streak} dage i streg` : `${entries.length} målinger`;
}

function renderEntryState(entries) {
  const today = entries.find(e => e.date === todayISO());
  const badge = document.getElementById('todayBadge');
  const input = document.getElementById('weight');
  const label = document.getElementById('entryLabel');
  if (today) {
    badge.hidden = false;
    badge.textContent = `I dag: ${fmtKg(today.kg)} kg`;
    label.textContent = 'Ret dagens vægt';
    if (!input.value) input.placeholder = fmtKg(today.kg);
  } else {
    badge.hidden = true;
    label.textContent = 'Dagens vægt';
    input.placeholder = '0,0';
  }
}

function renderStats(entries) {
  const avg7El = document.getElementById('avg7');
  const trend7El = document.getElementById('trend7');
  const rateEl = document.getElementById('rate');
  const rateSub = document.getElementById('rateSub');

  if (!entries.length) {
    avg7El.textContent = '–'; trend7El.textContent = '';
    rateEl.textContent = '–'; rateSub.textContent = 'kg / uge';
    return;
  }

  const latest = entries[entries.length - 1];
  const avg = rolling7Avg(entries);
  avg7El.textContent = avg != null ? `${fmtKg(avg)}` : '–';

  // trend vs previous 7-day window
  const prevAvg = rolling7Avg(entries, shiftDate(latest.date, -7));
  if (avg != null && prevAvg != null) {
    const diff = avg - prevAvg;
    const arrow = diff > 0.05 ? '▲' : diff < -0.05 ? '▼' : '▬';
    trend7El.textContent = `${arrow} ${fmtKg(Math.abs(diff))} vs. forrige uge`;
    trend7El.className = 'stat-trend ' + (diff > 0.05 ? 'up' : diff < -0.05 ? 'down' : '');
  } else {
    trend7El.textContent = 'kg';
    trend7El.className = 'stat-trend';
  }

  // weekly rate (tempo)
  const rate = weeklyRate(entries);
  if (rate != null) {
    rateEl.textContent = fmtSigned(rate);
    rateSub.textContent = 'kg / uge';
    rateEl.style.color = Math.abs(rate) < 0.05 ? '' : (rate < 0 ? 'var(--good)' : 'var(--bad)');
  } else {
    rateEl.textContent = '–';
    rateEl.style.color = '';
    rateSub.textContent = 'mangler data';
  }
}

function renderBMI(entries, settings) {
  const card = document.getElementById('bmiCard');
  const prompt = document.getElementById('bmiPrompt');
  if (settings.heightCm == null) {
    card.hidden = true;
    prompt.hidden = entries.length === 0; // only nudge once they're tracking
    return;
  }
  prompt.hidden = true;
  if (!entries.length) { card.hidden = true; return; }
  card.hidden = false;

  const h = settings.heightCm / 100;
  const current = entries[entries.length - 1].kg;
  const bmi = current / (h * h);

  let cat, cls;
  if (bmi < 18.5) { cat = 'Undervægt'; cls = 'under'; }
  else if (bmi < 25) { cat = 'Normalvægt'; cls = 'normal'; }
  else if (bmi < 30) { cat = 'Overvægt'; cls = 'over'; }
  else { cat = 'Svær overvægt'; cls = 'obese'; }

  document.getElementById('bmiValue').textContent = bmi.toLocaleString('da-DK', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const catEl = document.getElementById('bmiCat');
  catEl.textContent = cat;
  catEl.className = 'bmi-cat ' + cls;

  // Normal-weight range for this height (BMI 18.5–24.9)
  const lo = 18.5 * h * h, hi = 24.9 * h * h;
  document.getElementById('bmiSub').textContent = `Normal: ${fmtKg(lo)}–${fmtKg(hi)} kg`;

  // marker on a 15–35 scale
  const pct = Math.max(0, Math.min(100, ((bmi - 15) / (35 - 15)) * 100));
  document.getElementById('bmiMarker').style.left = pct + '%';
}

function renderGoal(entries, settings) {
  const card = document.getElementById('goalCard');
  const prompt = document.getElementById('setGoalPrompt');
  const goalLegend = document.getElementById('goalLegend');
  const goalLegendTxt = document.getElementById('goalLegendTxt');

  if (settings.goalKg == null) {
    card.hidden = true;
    prompt.hidden = false;
    goalLegend.hidden = true; goalLegendTxt.hidden = true;
    return;
  }
  card.hidden = false;
  prompt.hidden = true;
  goalLegend.hidden = false; goalLegendTxt.hidden = false;

  const goal = settings.goalKg;
  document.getElementById('goalTarget').textContent = `${fmtKg(goal)} kg`;

  if (!entries.length) {
    document.getElementById('progressFill').style.width = '0%';
    document.getElementById('goalStart').textContent = 'Indtast en vægt for at starte';
    document.getElementById('goalRemaining').textContent = '';
    document.getElementById('goalEta').textContent = '';
    return;
  }

  const start = entries[0].kg;
  const current = entries[entries.length - 1].kg;
  const total = goal - start;       // signed
  const done = current - start;     // signed
  let pct = total === 0 ? 100 : (done / total) * 100;
  pct = Math.max(0, Math.min(100, pct));
  document.getElementById('progressFill').style.width = pct.toFixed(0) + '%';

  document.getElementById('goalStart').textContent = `Start ${fmtKg(start)} → nu ${fmtKg(current)} kg`;

  const remaining = goal - current;
  const reached = (total > 0 && current >= goal) || (total < 0 && current <= goal) || Math.abs(remaining) < 0.05;
  document.getElementById('goalRemaining').textContent = reached
    ? '🎉 Mål nået!'
    : `${fmtKg(Math.abs(remaining))} kg tilbage`;

  // ETA from current weekly rate
  const eta = document.getElementById('goalEta');
  const rate = weeklyRate(entries);
  if (reached) {
    eta.textContent = `Du er ${pct.toFixed(0)}% i mål — flot arbejde 💪`;
  } else if (rate != null && Math.abs(rate) > 0.02 && Math.sign(rate) === Math.sign(remaining)) {
    const weeks = remaining / rate;
    const etaDate = shiftDate(todayISO(), Math.round(weeks * 7));
    eta.textContent = `Ved nuværende tempo: ~${weeks.toFixed(0)} uger (omkr. ${formatDate(etaDate)})`;
  } else if (rate != null && Math.abs(rate) > 0.02) {
    eta.textContent = 'Du bevæger dig væk fra målet lige nu';
  } else {
    eta.textContent = `${pct.toFixed(0)}% af vejen`;
  }
}

function renderHistory(entries) {
  const ul = document.getElementById('history');
  const empty = document.getElementById('emptyMsg');
  ul.innerHTML = '';
  if (!entries.length) { empty.style.display = 'block'; return; }
  empty.style.display = 'none';

  const reversed = [...entries].reverse();
  reversed.forEach((e, i) => {
    const prev = reversed[i + 1]; // previous chronological entry
    let deltaHtml = '';
    if (prev) {
      const d = e.kg - prev.kg;
      const cls = d > 0.05 ? 'up' : d < -0.05 ? 'down' : 'flat';
      const sign = d > 0.05 ? '+' : d < -0.05 ? '−' : '±';
      deltaHtml = `<span class="h-delta ${cls}">${sign}${fmtKg(Math.abs(d))}</span>`;
    }
    const li = document.createElement('li');
    li.innerHTML = `
      <div>
        <div class="h-date">${formatDate(e.date)}</div>
        <div class="h-day">${dayName(e.date)}</div>
      </div>
      <div class="h-right">
        ${deltaHtml}
        <span class="h-weight">${fmtKg(e.kg)} kg</span>
        <button class="h-delete" aria-label="Slet" data-date="${e.date}">🗑</button>
      </div>`;
    ul.appendChild(li);
  });

  ul.querySelectorAll('.h-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('Slet denne måling?')) { deleteEntry(btn.dataset.date); render(); toast('Måling slettet'); }
    });
  });
}

// --- Chart (canvas, no dependencies) --------------------------------------

function renderChart(entries, settings) {
  const canvas = document.getElementById('chart');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = 210;
  canvas.width = cssW * dpr; canvas.height = cssH * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  let data = entries;
  if (currentRange > 0 && entries.length) {
    const end = entries[entries.length - 1].date;
    data = entries.filter(e => daysBetween(e.date, end) < currentRange);
  }

  if (data.length < 1) {
    ctx.fillStyle = '#64748b';
    ctx.font = '14px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Endnu ingen data at vise', cssW / 2, cssH / 2);
    return;
  }

  const P = { l: 40, r: 12, t: 16, b: 24 };
  const plotW = cssW - P.l - P.r;
  const plotH = cssH - P.t - P.b;

  const avgSeries = data.map(e => rolling7Avg(entries, e.date));
  const goal = settings.goalKg;

  const allVals = data.map(e => e.kg).concat(avgSeries.filter(v => v != null));
  if (goal != null) allVals.push(goal);
  let min = Math.min(...allVals), max = Math.max(...allVals);
  if (min === max) { min -= 1; max += 1; }
  const range = max - min;
  min -= range * 0.14; max += range * 0.14;
  const span = max - min;

  const xMin = parseISO(data[0].date).getTime();
  const xMax = parseISO(data[data.length - 1].date).getTime();
  const xSpan = Math.max(1, xMax - xMin);
  const xOf = iso => P.l + ((parseISO(iso).getTime() - xMin) / xSpan) * plotW;
  const yOf = kg => P.t + (1 - (kg - min) / span) * plotH;

  // gridlines + labels
  ctx.strokeStyle = '#263248';
  ctx.fillStyle = '#64748b';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  ctx.lineWidth = 1;
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = min + span * (i / steps);
    const y = yOf(v);
    ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.moveTo(P.l, y); ctx.lineTo(cssW - P.r, y); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(v.toFixed(1), P.l - 6, y + 3);
  }

  // goal line
  if (goal != null && goal >= min && goal <= max) {
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    const gy = yOf(goal);
    ctx.beginPath(); ctx.moveTo(P.l, gy); ctx.lineTo(cssW - P.r, gy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#fbbf24'; ctx.textAlign = 'left'; ctx.font = '10px -apple-system, sans-serif';
    ctx.fillText('mål', P.l + 3, gy - 4);
  }

  // area under avg
  const avgPts = data.map((e, i) => avgSeries[i] != null ? [xOf(e.date), yOf(avgSeries[i])] : null).filter(Boolean);
  if (avgPts.length > 1) {
    const grad = ctx.createLinearGradient(0, P.t, 0, P.t + plotH);
    grad.addColorStop(0, 'rgba(129,140,248,.22)');
    grad.addColorStop(1, 'rgba(129,140,248,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(avgPts[0][0], P.t + plotH);
    avgPts.forEach(p => ctx.lineTo(p[0], p[1]));
    ctx.lineTo(avgPts[avgPts.length - 1][0], P.t + plotH);
    ctx.closePath(); ctx.fill();
  }

  drawLine(ctx, data, avgSeries, xOf, yOf, '#818cf8', 2.6);
  drawLine(ctx, data, data.map(e => e.kg), xOf, yOf, '#38bdf8', 2);

  ctx.fillStyle = '#38bdf8';
  data.forEach(e => { ctx.beginPath(); ctx.arc(xOf(e.date), yOf(e.kg), 2.6, 0, Math.PI * 2); ctx.fill(); });

  ctx.fillStyle = '#64748b'; ctx.font = '11px -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(formatDate(data[0].date), P.l, cssH - 6);
  if (data.length > 1) {
    ctx.textAlign = 'right';
    ctx.fillText(formatDate(data[data.length - 1].date), cssW - P.r, cssH - 6);
  }
}

function drawLine(ctx, data, values, xOf, yOf, color, width) {
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.beginPath();
  let started = false;
  data.forEach((e, i) => {
    const v = values[i]; if (v == null) return;
    const x = xOf(e.date), y = yOf(v);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

// --- Reminders -------------------------------------------------------------

let reminderTimer = null;

function renderReminderBanner(entries, settings) {
  const banner = document.getElementById('reminderBanner');
  const loggedToday = entries.some(e => e.date === todayISO());
  if (dismissedBannerToday() || loggedToday || !settings.reminderEnabled) {
    banner.hidden = true; return;
  }
  // show if current time >= reminder time
  const now = new Date();
  const [h, m] = settings.reminderTime.split(':').map(Number);
  const past = now.getHours() > h || (now.getHours() === h && now.getMinutes() >= m);
  banner.hidden = !past;
}

function dismissedBannerToday() {
  return localStorage.getItem('vaegt-banner-dismissed') === todayISO();
}

function scheduleNotification(settings) {
  if (reminderTimer) { clearTimeout(reminderTimer); reminderTimer = null; }
  if (!settings.reminderEnabled) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const [h, m] = settings.reminderTime.split(':').map(Number);
  const now = new Date();
  const next = new Date();
  next.setHours(h, m, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  // setTimeout only fires while the page/SW is alive — best effort for open app.
  reminderTimer = setTimeout(() => {
    const logged = loadEntries().some(e => e.date === todayISO());
    if (!logged) {
      try { new Notification('Vægt Tracker', { body: '☀️ Husk at veje dig i dag', icon: 'icons/icon-192.png' }); }
      catch {}
    }
    scheduleNotification(loadSettings()); // re-arm for next day
    render();
  }, Math.min(delay, 2 ** 31 - 1));
}

// --- Settings sheet --------------------------------------------------------

function openSheet() {
  const s = loadSettings();
  document.getElementById('goalInput').value = s.goalKg != null ? s.goalKg : '';
  document.getElementById('heightInput').value = s.heightCm != null ? s.heightCm : '';
  const strat = s.strategy || 'maintain';
  document.getElementById('tempoInput').value = strat === 'maintain' ? '' : (Math.abs(s.desiredRate || 0) || '');
  applyStrategyUI(strat);
  document.getElementById('reminderToggle').checked = s.reminderEnabled;
  document.getElementById('reminderTime').value = s.reminderTime;
  document.getElementById('reminderTimeRow').hidden = !s.reminderEnabled;
  updateNotifNote();
  document.getElementById('sheetOverlay').hidden = false;
  document.getElementById('sheet').hidden = false;
}

function applyStrategyUI(strategy) {
  document.querySelectorAll('#strategyToggle button').forEach(b =>
    b.classList.toggle('active', b.dataset.strat === strategy));
  document.getElementById('tempoRow').hidden = strategy === 'maintain';
  const hint = document.getElementById('tempoHint');
  if (strategy === 'cut') hint.textContent = 'Typisk 0,5 kg/uge. Højere = hurtigere, men sværere at bevare muskel.';
  else if (strategy === 'gain') hint.textContent = 'Lean bulk ~0,25 kg/uge. Højere = mere fedt med på.';
  else hint.textContent = '';
}
function closeSheet() {
  document.getElementById('sheetOverlay').hidden = true;
  document.getElementById('sheet').hidden = true;
}

function updateNotifNote() {
  const note = document.getElementById('notifNote');
  const on = document.getElementById('reminderToggle').checked;
  if (!on) { note.hidden = true; return; }
  note.hidden = false;
  if (!('Notification' in window)) {
    note.textContent = 'Din browser understøtter ikke notifikationer — du får i stedet en påmindelse i appen.';
  } else if (Notification.permission === 'denied') {
    note.textContent = '⚠️ Notifikationer er blokeret i browseren. Du får stadig en påmindelse i appen, når du åbner den.';
  } else {
    note.textContent = 'På iPhone virker notifikationer kun når appen er føjet til hjemmeskærmen. Ellers vises påmindelsen i appen.';
  }
}

function persistSettingsFromSheet() {
  const goalRaw = document.getElementById('goalInput').value.replace(',', '.').trim();
  const goalKg = goalRaw === '' ? null : parseFloat(goalRaw);
  const heightRaw = document.getElementById('heightInput').value.replace(',', '.').trim();
  const heightCm = heightRaw === '' ? null : parseFloat(heightRaw);
  const activeStrat = document.querySelector('#strategyToggle button.active');
  const strategy = activeStrat ? activeStrat.dataset.strat : 'maintain';
  const tempoAbs = Math.abs(parseFloat(document.getElementById('tempoInput').value.replace(',', '.')) || 0);
  const desiredRate = strategy === 'cut' ? -tempoAbs : strategy === 'gain' ? tempoAbs : 0;
  const s = {
    goalKg: (goalKg != null && !isNaN(goalKg) && goalKg > 0 && goalKg < 500) ? Math.round(goalKg * 10) / 10 : null,
    heightCm: (heightCm != null && !isNaN(heightCm) && heightCm > 50 && heightCm < 260) ? Math.round(heightCm) : null,
    strategy,
    desiredRate: Math.round(desiredRate * 100) / 100,
    reminderEnabled: document.getElementById('reminderToggle').checked,
    reminderTime: document.getElementById('reminderTime').value || '07:30',
  };
  saveSettings(s);
  scheduleNotification(s);
  render();
  return s;
}

// --- Toast -----------------------------------------------------------------

let toastTimer = null;
function toast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  t.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2200);
}

// --- Meals / nutrition -----------------------------------------------------

const MEALS_KEY = 'vaegt-meals-v1';
const KCAL_PER_KG = 7700;          // ~kcal per kg body weight
const RICE_KCAL_PER_G = 1.3;       // cooked rice ≈ 130 kcal / 100 g
let mealsDate = todayISO();

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function num(v) { const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? 0 : n; }
function fmtNum(n) { return Math.round(n).toLocaleString('da-DK'); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function loadAllMeals() { try { return JSON.parse(localStorage.getItem(MEALS_KEY) || '{}') || {}; } catch { return {}; } }
function saveAllMeals(obj) { localStorage.setItem(MEALS_KEY, JSON.stringify(obj)); }
function getMeals(date) { return loadAllMeals()[date] || []; }
function setMeals(date, meals) {
  const all = loadAllMeals();
  if (meals.length) all[date] = meals; else delete all[date];
  saveAllMeals(all);
}

// Food library — remembers foods so they can be re-added with one tap.
const FOODS_KEY = 'vaegt-foods-v1';
function loadFoodLib() { try { return JSON.parse(localStorage.getItem(FOODS_KEY) || '[]') || []; } catch { return []; } }
function saveFoodLib(arr) { localStorage.setItem(FOODS_KEY, JSON.stringify(arr.slice(0, 60))); }
function rememberFood(food) {
  const lib = loadFoodLib().filter(f => f.name.toLowerCase() !== food.name.toLowerCase());
  lib.unshift({ name: food.name, kcal: food.kcal, protein: food.protein, fat: food.fat, carbs: food.carbs });
  saveFoodLib(lib);
}
function findInLib(name) {
  return loadFoodLib().find(f => f.name.toLowerCase() === name.trim().toLowerCase()) || null;
}

// Saved meal templates ("retter") — remember meal names + their foods for re-use.
const MEAL_TPL_KEY = 'vaegt-meal-templates-v1';
function loadMealTemplates() { try { return JSON.parse(localStorage.getItem(MEAL_TPL_KEY) || '[]') || []; } catch { return []; } }
function saveMealTemplates(arr) { localStorage.setItem(MEAL_TPL_KEY, JSON.stringify(arr.slice(0, 40))); }
function upsertMealTemplate(name, foods) {
  name = (name || '').trim(); if (!name) return;
  const all = loadMealTemplates();
  const idx = all.findIndex(t => t.name.toLowerCase() === name.toLowerCase());
  const cleanFoods = (foods || []).map(f => ({ name: f.name, kcal: num(f.kcal), protein: num(f.protein), fat: num(f.fat), carbs: num(f.carbs) }));
  let entry;
  if (idx >= 0) {
    entry = all.splice(idx, 1)[0];
    entry.name = name;
    if (cleanFoods.length) entry.foods = cleanFoods; // only overwrite foods when provided
  } else {
    entry = { name, foods: cleanFoods };
  }
  all.unshift(entry);
  saveMealTemplates(all);
}
function removeMealTemplate(name) {
  saveMealTemplates(loadMealTemplates().filter(t => t.name.toLowerCase() !== name.toLowerCase()));
}

function mealTotals(meal) {
  return meal.foods.reduce((t, f) => ({
    kcal: t.kcal + num(f.kcal), protein: t.protein + num(f.protein),
    fat: t.fat + num(f.fat), carbs: t.carbs + num(f.carbs),
  }), { kcal: 0, protein: 0, fat: 0, carbs: 0 });
}
function dayTotals(meals) {
  return meals.reduce((t, m) => {
    const mt = mealTotals(m);
    return { kcal: t.kcal + mt.kcal, protein: t.protein + mt.protein, fat: t.fat + mt.fat, carbs: t.carbs + mt.carbs };
  }, { kcal: 0, protein: 0, fat: 0, carbs: 0 });
}

function mealDateLabel(date) {
  if (date === todayISO()) return 'I dag';
  if (date === shiftDate(todayISO(), -1)) return 'I går';
  const d = parseISO(date);
  return `${DAYS[d.getDay()]} ${d.getDate()}. ${MONTHS[d.getMonth()]}`;
}

function renderMeals() {
  const meals = getMeals(mealsDate);
  document.getElementById('mealDateLabel').textContent = mealDateLabel(mealsDate);
  document.getElementById('mealNext').disabled = mealsDate >= todayISO();

  const totals = dayTotals(meals);
  document.getElementById('dayKcal').textContent = fmtNum(totals.kcal);
  document.getElementById('dayProtein').textContent = fmtNum(totals.protein) + ' g';
  document.getElementById('dayFat').textContent = fmtNum(totals.fat) + ' g';
  document.getElementById('dayCarbs').textContent = fmtNum(totals.carbs) + ' g';

  renderGuidance(totals);

  const list = document.getElementById('mealsList');
  list.innerHTML = '';
  document.getElementById('mealsEmpty').hidden = meals.length > 0;
  meals.forEach(meal => list.appendChild(renderMealCard(meal)));

  renderSavedMeals();
}

function renderSavedMeals() {
  const tpls = loadMealTemplates();
  const wrap = document.getElementById('savedMeals');
  const row = document.getElementById('savedMealsRow');
  if (!tpls.length) { wrap.hidden = true; row.innerHTML = ''; return; }
  wrap.hidden = false;
  row.innerHTML = tpls.map((t, i) =>
    `<button class="quick-meal saved" data-tpl="${i}">${esc(t.name)}${t.foods.length ? `<small>${t.foods.length} stk</small>` : ''}<span class="tpl-x" data-tplx="${i}" aria-label="Fjern">✕</span></button>`
  ).join('');
  row.querySelectorAll('.quick-meal.saved').forEach(chip => {
    chip.addEventListener('click', e => {
      const x = e.target.closest('[data-tplx]');
      if (x) {
        const t = tpls[Number(x.dataset.tplx)];
        if (confirm(`Fjern "${t.name}" fra dine gemte retter?`)) { removeMealTemplate(t.name); renderSavedMeals(); }
        return;
      }
      addMealFromTemplate(tpls[Number(chip.dataset.tpl)]);
    });
  });
}

function renderMealCard(meal) {
  const t = mealTotals(meal);
  const card = document.createElement('section');
  card.className = 'card meal';
  card.dataset.id = meal.id;
  const foodsHtml = meal.foods.length ? meal.foods.map(f => `
    <li class="food" data-food="${f.id}">
      <div class="food-info">
        <span class="food-name">${esc(f.name)}</span>
        <span class="food-macros"><span class="m-prot">P ${fmtNum(num(f.protein))}</span> · <span class="m-fat">F ${fmtNum(num(f.fat))}</span> · <span class="m-carb">K ${fmtNum(num(f.carbs))}</span></span>
      </div>
      <span class="food-kcal">${fmtNum(num(f.kcal))}<small>kcal</small></span>
    </li>`).join('') : '<p class="meal-empty">Ingen fødevarer endnu</p>';
  card.innerHTML = `
    <div class="meal-head">
      <button class="meal-name" data-rename>${esc(meal.name)}</button>
      <div class="meal-head-right">
        <span class="meal-kcal">${fmtNum(t.kcal)} kcal</span>
        <button class="meal-save" data-save aria-label="Gem som ret">Gem</button>
        <button class="meal-del" data-del aria-label="Slet måltid">Slet</button>
      </div>
    </div>
    <ul class="foods">${foodsHtml}</ul>
    <button class="add-food" data-add>+ Tilføj fødevare</button>`;
  return card;
}

function addMeal(name) {
  const meals = getMeals(mealsDate);
  meals.push({ id: uid(), name: name || 'Måltid', foods: [] });
  setMeals(mealsDate, meals);
  renderMeals();
  toast(`“${name}” tilføjet`);
}
function addMealFromTemplate(tpl) {
  const meals = getMeals(mealsDate);
  meals.push({
    id: uid(), name: tpl.name,
    foods: tpl.foods.map(f => ({ id: uid(), name: f.name, kcal: num(f.kcal), protein: num(f.protein), fat: num(f.fat), carbs: num(f.carbs) })),
  });
  setMeals(mealsDate, meals);
  renderMeals();
  toast(`“${tpl.name}” tilføjet`);
}

function saveMealAsTemplate(id) {
  const meal = getMeals(mealsDate).find(m => m.id === id);
  if (!meal) return;
  upsertMealTemplate(meal.name, meal.foods);
  renderSavedMeals();
  toast(meal.foods.length ? `“${meal.name}” gemt som ret (${meal.foods.length} stk)` : `“${meal.name}” gemt`);
}

function renameMeal(id) {
  const meals = getMeals(mealsDate);
  const m = meals.find(x => x.id === id); if (!m) return;
  const name = prompt('Navn på måltid:', m.name);
  if (name && name.trim()) { m.name = name.trim(); setMeals(mealsDate, meals); renderMeals(); }
}
function deleteMeal(id) {
  if (!confirm('Slet hele måltidet?')) return;
  setMeals(mealsDate, getMeals(mealsDate).filter(m => m.id !== id));
  renderMeals();
  toast('Måltid slettet');
}

// Food entry sheet
let foodCtx = { mealId: null, foodId: null };
function openFoodSheet(mealId, foodId) {
  const meal = getMeals(mealsDate).find(m => m.id === mealId);
  if (!meal) return;
  foodCtx = { mealId, foodId: foodId || null };
  const food = foodId ? meal.foods.find(f => f.id === foodId) : null;
  document.getElementById('foodSheetTitle').textContent = food ? 'Rediger fødevare' : 'Tilføj fødevare';
  document.getElementById('foodName').value = food ? food.name : '';
  document.getElementById('foodKcal').value = food && food.kcal ? food.kcal : '';
  document.getElementById('foodProtein').value = food && food.protein ? food.protein : '';
  document.getElementById('foodFat').value = food && food.fat ? food.fat : '';
  document.getElementById('foodCarbs').value = food && food.carbs ? food.carbs : '';
  document.getElementById('foodDelete').hidden = !food;
  populateFoodLibUI(!food); // show recent chips only when adding new
  document.getElementById('foodOverlay').hidden = false;
  document.getElementById('foodSheet').hidden = false;
  setTimeout(() => document.getElementById('foodName').focus(), 50);
}

function fillFoodFields(f) {
  document.getElementById('foodName').value = f.name;
  document.getElementById('foodKcal').value = f.kcal || '';
  document.getElementById('foodProtein').value = f.protein || '';
  document.getElementById('foodFat').value = f.fat || '';
  document.getElementById('foodCarbs').value = f.carbs || '';
}

function populateFoodLibUI(showRecent) {
  const lib = loadFoodLib();
  // datalist for autocomplete
  document.getElementById('foodLibList').innerHTML =
    lib.map(f => `<option value="${esc(f.name)}">`).join('');
  // recent chips for one-tap fill
  const row = document.getElementById('recentFoods');
  if (!showRecent || !lib.length) { row.hidden = true; row.innerHTML = ''; return; }
  row.hidden = false;
  row.innerHTML = lib.slice(0, 12).map((f, i) =>
    `<button class="recent-chip" data-lib="${i}">${esc(f.name)}<small>${fmtNum(f.kcal)} kcal</small></button>`).join('');
  row.querySelectorAll('.recent-chip').forEach(chip =>
    chip.addEventListener('click', () => fillFoodFields(lib[Number(chip.dataset.lib)])));
}
function closeFoodSheet() {
  document.getElementById('foodOverlay').hidden = true;
  document.getElementById('foodSheet').hidden = true;
}
function saveFood() {
  const name = document.getElementById('foodName').value.trim();
  if (!name) { toast('Giv fødevaren et navn', true); return; }
  const data = {
    name,
    kcal: num(document.getElementById('foodKcal').value),
    protein: num(document.getElementById('foodProtein').value),
    fat: num(document.getElementById('foodFat').value),
    carbs: num(document.getElementById('foodCarbs').value),
  };
  const meals = getMeals(mealsDate);
  const meal = meals.find(m => m.id === foodCtx.mealId);
  if (!meal) { closeFoodSheet(); return; }
  if (foodCtx.foodId) {
    const f = meal.foods.find(x => x.id === foodCtx.foodId);
    if (f) Object.assign(f, data);
  } else {
    meal.foods.push({ id: uid(), ...data });
  }
  setMeals(mealsDate, meals);
  rememberFood(data);
  closeFoodSheet();
  renderMeals();
  toast('Fødevare gemt');
}
function deleteFood() {
  const meals = getMeals(mealsDate);
  const meal = meals.find(m => m.id === foodCtx.mealId);
  if (meal) { meal.foods = meal.foods.filter(f => f.id !== foodCtx.foodId); setMeals(mealsDate, meals); }
  closeFoodSheet();
  renderMeals();
  toast('Fødevare slettet');
}

// Eating guidance — ties nutrition to the weight goal & actual tempo.
function applyGuidance(g, cardId, iconId, textId) {
  const card = document.getElementById(cardId);
  if (!g) { card.hidden = true; return; }
  card.hidden = false;
  document.getElementById(iconId).textContent = g.icon;
  document.getElementById(textId).innerHTML = g.html;
}

function renderGuidance(totals) {
  const g = computeGuidance(loadEntries(), loadSettings(), totals.kcal);
  applyGuidance(g, 'guidanceCard', 'guidanceIcon', 'guidanceText');
}

// Weight-page mirror — uses today's logged kcal.
function renderGuidanceWeight() {
  const todayKcal = dayTotals(getMeals(todayISO())).kcal;
  const g = computeGuidance(loadEntries(), loadSettings(), todayKcal);
  applyGuidance(g, 'guidanceCardW', 'guidanceIconW', 'guidanceTextW');
}

function computeGuidance(entries, settings, todayKcal) {
  if (entries.length < 3)
    return { icon: '📈', html: 'Log din vægt et par dage mere, så beregner jeg dit kalorie-tempo her.' };
  const actualRate = weeklyRate(entries);
  if (actualRate == null)
    return { icon: '📈', html: 'Log din vægt nogle dage mere for en anbefaling.' };

  const rateTxt = fmtSigned(actualRate);
  const strategy = settings.strategy || 'maintain';
  const desiredRate = strategy === 'maintain' ? 0 : (settings.desiredRate || 0);
  const dailyDelta = (desiredRate - actualRate) * KCAL_PER_KG / 7; // + => spis mere
  const absKcal = Math.round(Math.abs(dailyDelta) / 50) * 50;
  const rice = Math.round(Math.abs(dailyDelta) / RICE_KCAL_PER_G / 10) * 10;
  const eaten = `Du har spist <b>${fmtNum(todayKcal)} kcal</b> i dag.`;

  if (strategy === 'maintain') {
    if (Math.abs(actualRate) < 0.12)
      return { icon: '✅', html: `Du holder vægten flot (${rateTxt} kg/uge). Spis til vedligehold. ${eaten}` };
    const more = actualRate < 0; // losing -> eat more to hold
    return { icon: more ? '🍚' : '🥗', html: `Du vil <b>holde</b> vægten, men du ${more ? 'taber dig' : 'tager på'} (${rateTxt} kg/uge). ${more ? 'Spis' : 'Skær'} ca. <b>${absKcal} kcal/dag</b> ≈ <b>${rice} g kogt ris</b> ${more ? 'mere' : 'mindre'} for at stabilisere. ${eaten}` };
  }

  if (strategy === 'gain') {
    if (dailyDelta > 60)
      return { icon: '🍚', html: `Mål: <b>opbygning</b> (${fmtSigned(desiredRate)} kg/uge), men dit tempo er ${rateTxt} kg/uge. Spis ca. <b>+${absKcal} kcal/dag</b> ≈ <b>${rice} g kogt ris</b> ekstra. ${eaten}` };
    if (dailyDelta < -60)
      return { icon: '⚖️', html: `Du tager hurtigere på (${rateTxt} kg/uge) end dit mål (${fmtSigned(desiredRate)} kg/uge). Du kan skære ca. <b>${absKcal} kcal/dag</b> for renere gains. ${eaten}` };
    return { icon: '💪', html: `Flot — du opbygger i præcis det tempo du vil (${rateTxt} kg/uge). Hold indtaget. ${eaten}` };
  }

  // cut
  if (dailyDelta < -60)
    return { icon: '🥗', html: `Mål: <b>vægttab</b> (${fmtSigned(desiredRate)} kg/uge), men dit tempo er ${rateTxt} kg/uge. Skær ca. <b>${absKcal} kcal/dag</b> ≈ <b>${rice} g kogt ris</b> mindre. ${eaten}` };
  if (dailyDelta > 60)
    return { icon: '⚠️', html: `Du taber dig hurtigere (${rateTxt} kg/uge) end dit mål (${fmtSigned(desiredRate)} kg/uge). Overvej at spise <b>+${absKcal} kcal/dag</b> for at bevare muskelmasse. ${eaten}` };
  return { icon: '🔥', html: `Godt tempo — du taber dig ${rateTxt} kg/uge som planlagt. Fortsæt. ${eaten}` };
}

// --- Page navigation -------------------------------------------------------

function showPage(page) {
  document.getElementById('page-weight').hidden = page !== 'weight';
  document.getElementById('page-meals').hidden = page !== 'meals';
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.page === page));
  document.getElementById('pageTitle').textContent = page === 'meals' ? 'Mad' : 'Vægt';
  document.getElementById('streak').style.display = page === 'meals' ? 'none' : '';
  if (page === 'meals') renderMeals(); else render();
}

// --- Actions ---------------------------------------------------------------

function handleSave() {
  const input = document.getElementById('weight');
  const raw = input.value.replace(',', '.').trim();
  const kg = parseFloat(raw);
  if (!raw || isNaN(kg) || kg <= 0 || kg > 500) {
    toast('Indtast en gyldig vægt (0–500 kg)', true);
    return;
  }
  const rounded = Math.round(kg * 10) / 10;
  upsertEntry(todayISO(), rounded);
  input.value = ''; input.blur();
  render();
  toast(`✓ Gemt: ${fmtKg(rounded)} kg`);
}

function handleExport() {
  const entries = loadEntries();
  if (!entries.length) { toast('Ingen data at eksportere', true); return; }
  let csv = 'dato;vaegt_kg\n';
  entries.forEach(e => { csv += `${e.date};${fmtKg(e.kg)}\n`; });
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `vaegt-${todayISO()}.csv`; a.click();
  URL.revokeObjectURL(url);
  toast('CSV eksporteret');
}

// --- Inline goal editing ---------------------------------------------------

function openGoalEditor() {
  const row = document.getElementById('goalEditRow');
  const input = document.getElementById('goalEditInput');
  const s = loadSettings();
  input.value = s.goalKg != null ? s.goalKg : '';
  document.getElementById('goalEditBtn').hidden = true;
  row.hidden = false;
  input.focus();
  input.select();
}

function closeGoalEditor() {
  document.getElementById('goalEditRow').hidden = true;
  document.getElementById('goalEditBtn').hidden = false;
}

function saveGoalFromEditor() {
  const raw = document.getElementById('goalEditInput').value.replace(',', '.').trim();
  const goalKg = parseFloat(raw);
  if (!raw || isNaN(goalKg) || goalKg <= 0 || goalKg > 500) {
    toast('Indtast et gyldigt mål (0–500 kg)', true);
    return;
  }
  const s = loadSettings();
  s.goalKg = Math.round(goalKg * 10) / 10;
  saveSettings(s);
  closeGoalEditor();
  render();
  toast(`Mål opdateret: ${fmtKg(s.goalKg)} kg`);
}

function handleImport(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const text = String(reader.result);
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      const parsed = [];
      for (const line of lines) {
        // pick delimiter so Danish comma-decimal (88,9) isn't split apart:
        // ';' or tab takes priority; only fall back to ',' for international CSVs.
        const delim = line.includes(';') ? ';' : line.includes('\t') ? '\t' : ',';
        const parts = line.split(delim).map(s => s.trim());
        const date = parts[0];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue; // skip header / junk
        const kg = parseFloat((parts[1] || '').replace(',', '.'));
        if (isNaN(kg) || kg <= 0 || kg > 500) continue;
        parsed.push({ date, kg: Math.round(kg * 10) / 10 });
      }
      if (!parsed.length) { toast('Ingen gyldige rækker fundet i filen', true); return; }

      const existing = loadEntries();
      const map = new Map(existing.map(e => [e.date, e.kg]));
      let added = 0, updated = 0;
      parsed.forEach(e => {
        if (map.has(e.date)) { if (map.get(e.date) !== e.kg) updated++; }
        else added++;
        map.set(e.date, e.kg);
      });
      const merged = [...map.entries()].map(([date, kg]) => ({ date, kg }));
      saveEntries(merged);
      render();
      toast(`Importeret: ${added} nye, ${updated} opdateret`);
    } catch {
      toast('Kunne ikke læse filen', true);
    }
  };
  reader.onerror = () => toast('Kunne ikke læse filen', true);
  reader.readAsText(file);
}

function handleClear() {
  if (confirm('Slet ALLE målinger? Dette kan ikke fortrydes.')) {
    localStorage.removeItem(ENTRIES_KEY);
    closeSheet();
    render();
    toast('Alle data slettet');
  }
}

// --- Wiring ----------------------------------------------------------------

document.getElementById('saveBtn').addEventListener('click', handleSave);
document.getElementById('weight').addEventListener('keydown', e => { if (e.key === 'Enter') handleSave(); });

document.getElementById('settingsBtn').addEventListener('click', openSheet);
document.getElementById('settingsSave').addEventListener('click', () => {
  persistSettingsFromSheet();
  closeSheet();
  toast('✓ Indstillinger gemt');
});
document.getElementById('sheetClose').addEventListener('click', () => { persistSettingsFromSheet(); closeSheet(); });
document.getElementById('sheetOverlay').addEventListener('click', () => { persistSettingsFromSheet(); closeSheet(); });

document.getElementById('goalInput').addEventListener('change', persistSettingsFromSheet);
document.getElementById('heightInput').addEventListener('change', persistSettingsFromSheet);
document.getElementById('tempoInput').addEventListener('change', persistSettingsFromSheet);
document.getElementById('reminderTime').addEventListener('change', persistSettingsFromSheet);
document.getElementById('setGoalPrompt').addEventListener('click', openSheet);
document.getElementById('bmiPrompt').addEventListener('click', openSheet);

document.querySelectorAll('#strategyToggle button').forEach(b => b.addEventListener('click', () => {
  const strat = b.dataset.strat;
  applyStrategyUI(strat);
  document.getElementById('tempoInput').value = strat === 'maintain' ? '' : Math.abs(STRATEGY_DEFAULT_RATE[strat]);
  persistSettingsFromSheet();
}));

// Auto-fill macros when a known food name is typed
document.getElementById('foodName').addEventListener('input', e => {
  const match = findInLib(e.target.value);
  if (match) {
    document.getElementById('foodKcal').value = match.kcal || '';
    document.getElementById('foodProtein').value = match.protein || '';
    document.getElementById('foodFat').value = match.fat || '';
    document.getElementById('foodCarbs').value = match.carbs || '';
  }
});

document.getElementById('goalEditBtn').addEventListener('click', openGoalEditor);
document.getElementById('goalEditSave').addEventListener('click', saveGoalFromEditor);
document.getElementById('goalEditCancel').addEventListener('click', closeGoalEditor);
document.getElementById('goalEditInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') saveGoalFromEditor();
  else if (e.key === 'Escape') closeGoalEditor();
});

document.getElementById('reminderToggle').addEventListener('change', async (e) => {
  if (e.target.checked && 'Notification' in window && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch {}
  }
  document.getElementById('reminderTimeRow').hidden = !e.target.checked;
  updateNotifNote();
  persistSettingsFromSheet();
});

document.getElementById('exportBtn').addEventListener('click', handleExport);
document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
document.getElementById('importFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) handleImport(file);
  e.target.value = ''; // allow re-importing same file
});
document.getElementById('clearBtn').addEventListener('click', handleClear);

document.getElementById('reminderDismiss').addEventListener('click', () => {
  localStorage.setItem('vaegt-banner-dismissed', todayISO());
  document.getElementById('reminderBanner').hidden = true;
});

document.getElementById('rangeToggle').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  currentRange = Number(btn.dataset.range);
  document.querySelectorAll('#rangeToggle button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderChart(loadEntries(), loadSettings());
});

window.addEventListener('resize', () => renderChart(loadEntries(), loadSettings()));

// Tabs + meals page
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => showPage(t.dataset.page)));
document.getElementById('mealPrev').addEventListener('click', () => { mealsDate = shiftDate(mealsDate, -1); renderMeals(); });
document.getElementById('mealNext').addEventListener('click', () => {
  if (mealsDate < todayISO()) { mealsDate = shiftDate(mealsDate, 1); renderMeals(); }
});
document.getElementById('mealDateLabel').addEventListener('click', () => { mealsDate = todayISO(); renderMeals(); });
document.querySelectorAll('.quick-meal[data-name]').forEach(b =>
  b.addEventListener('click', () => addMeal(b.dataset.name)));
document.getElementById('customMealBtn').addEventListener('click', () => {
  const n = prompt('Navn på måltid:');
  if (n && n.trim()) { addMeal(n.trim()); upsertMealTemplate(n.trim(), []); renderSavedMeals(); }
});
document.getElementById('mealsList').addEventListener('click', e => {
  const card = e.target.closest('.meal'); if (!card) return;
  const mealId = card.dataset.id;
  if (e.target.closest('[data-add]')) openFoodSheet(mealId, null);
  else if (e.target.closest('[data-rename]')) renameMeal(mealId);
  else if (e.target.closest('[data-save]')) saveMealAsTemplate(mealId);
  else if (e.target.closest('[data-del]')) deleteMeal(mealId);
  else { const li = e.target.closest('.food'); if (li) openFoodSheet(mealId, li.dataset.food); }
});
document.getElementById('foodSheetClose').addEventListener('click', closeFoodSheet);
document.getElementById('foodOverlay').addEventListener('click', closeFoodSheet);
document.getElementById('foodSave').addEventListener('click', saveFood);
document.getElementById('foodDelete').addEventListener('click', deleteFood);

if ('serviceWorker' in navigator) {
  // Auto-reload once when a new service worker takes control (new app version).
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

render();
scheduleNotification(loadSettings());
