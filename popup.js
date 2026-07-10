// popup.js

const slider          = document.getElementById('volumeSlider');
const volDisplay      = document.getElementById('volumeDisplay');
const gainReadout     = document.getElementById('gainReadout');
const meterMask       = document.getElementById('meterMask');
const meterSegWrap    = document.getElementById('meterSegments');
const siteBadge       = document.getElementById('siteBadge');
const effectBtns      = document.querySelectorAll('.effect-btn');
const resetBtn        = document.getElementById('resetBtn');
const statusDot       = document.getElementById('statusDot');
const bypassToggle    = document.getElementById('bypassToggle');
const badgeToggle     = document.getElementById('badgeToggle');

// ── Update checker (GitHub) ───────────────────────────────
const updateBtn         = document.getElementById('updateBtn');
const updateDot         = document.getElementById('updateDot');
const updatePanel       = document.getElementById('updatePanel');
const updateStatusIcon  = document.getElementById('updateStatusIcon');
const updateStatus      = document.getElementById('updateStatus');
const updateActions     = document.getElementById('updateActions');
const updateDownloadBtn = document.getElementById('updateDownloadBtn');

let lastUpdateInfo = null;

const ICONS = {
  loading: '<svg viewBox="0 0 16 16" fill="none"><path d="M13.5 4.5A6 6 0 1 0 14 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/><path d="M13.5 1.5v3.3h-3.3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
  available: '<svg viewBox="0 0 16 16" fill="none"><path d="M8 12.5V3.5M4.3 7.2 8 3.5l3.7 3.7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
  uptodate: '<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.7" stroke="currentColor" stroke-width="1.2" fill="none"/><path class="check-path" d="M4.7 8.3 7 10.6 11.3 5.9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
  error: '<svg viewBox="0 0 16 16" fill="none"><path d="M8 2 14.2 13H1.8Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/><path d="M8 6.4v3M8 11.3h.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};

// 同じテキスト/アイコンでも毎回アニメーションを再生させるための小技
// （クラスを外して reflow を強制してから付け直す）
function replayAnimation(el, className) {
  el.classList.remove(className);
  void el.offsetWidth; // force reflow
  el.classList.add(className);
}

function setStatusIcon(kind) {
  updateStatusIcon.className = 'update-status-icon icon-' + kind;
  updateStatusIcon.innerHTML = ICONS[kind] || '';
}

function renderUpdateInfo(info) {
  lastUpdateInfo = info;
  if (!info) return;

  updateDot.hidden = !info.available;

  updateStatus.classList.remove('is-available', 'is-error');
  if (info.error) {
    setStatusIcon('error');
    updateStatus.classList.add('is-error');
    updateStatus.textContent = `確認できませんでした (${info.error})`;
    updateActions.classList.remove('show');
  } else if (info.available) {
    setStatusIcon('available');
    updateStatus.classList.add('is-available');
    updateStatus.textContent = `新しいバージョンがあります: v${info.localVersion} → v${info.remoteVersion}`;
    updateActions.classList.add('show');
  } else {
    setStatusIcon('uptodate');
    updateStatus.textContent = `最新版です (v${info.localVersion})`;
    updateActions.classList.remove('show');
  }
  replayAnimation(updateStatus, 'fade-in');
}

// popup を開いた時点でキャッシュ済みの結果があればバッジだけ即反映
// （ネットワークは叩かない。実際のチェックはボタン操作 or 起動時/定期実行）
chrome.storage.local.get('update_info', (data) => {
  if (data?.update_info) renderUpdateInfo(data.update_info);
});

async function runUpdateCheck() {
  updateBtn.classList.add('spinning');
  setStatusIcon('loading');
  updateStatus.classList.remove('is-available', 'is-error');
  updateStatus.textContent = '確認中…';
  replayAnimation(updateStatus, 'fade-in');
  try {
    const info = await chrome.runtime.sendMessage({ type: 'SOUND_ENHANCE_CHECK_UPDATE' });
    renderUpdateInfo(info);
  } catch (e) {
    setStatusIcon('error');
    updateStatus.classList.add('is-error');
    updateStatus.textContent = '確認できませんでした';
    replayAnimation(updateStatus, 'fade-in');
  } finally {
    updateBtn.classList.remove('spinning');
    replayAnimation(updateBtn, 'pulse');
  }
}

updateBtn.addEventListener('click', () => {
  const willOpen = !updatePanel.classList.contains('open');
  updatePanel.classList.toggle('open', willOpen);
  if (willOpen) runUpdateCheck(); // 開いた時だけ最新情報を取りに行く
});

updateDownloadBtn.addEventListener('click', () => {
  if (!lastUpdateInfo?.zipUrl) return;
  const version = lastUpdateInfo.remoteVersion || 'latest';
  chrome.downloads.download({
    url: lastUpdateInfo.zipUrl,
    filename: `Sound Enhance/Enhance ${version}/Sound-Enhance-${version}.zip`,
  });
  // 置き換え作業をしやすいよう拡張機能ページも開いておく
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});

// Effect intensity — scales how strongly the active effect is applied.
// Stored/sent as an integer percentage (100 = 1.00x, default/current
// behavior), same convention as volume, range 0–300 (0.00x–3.00x).
const intensitySlider  = document.getElementById('intensitySlider');
const intensityDisplay = document.getElementById('intensityDisplay');
const intensityMask    = document.getElementById('intensityMask');

let currentHost  = '';
let currentTabId = null;

// ── Build the segmented meter overlay (visual only) ───────
const SEGMENT_COUNT = 30;
(function buildSegments() {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < SEGMENT_COUNT; i++) {
    frag.appendChild(document.createElement('span'));
  }
  meterSegWrap.appendChild(frag);
})();

// ── Helpers ──────────────────────────────────────────────
function getHost(url) {
  try { return new URL(url).hostname; }
  catch { return ''; }
}

function updateVolumeColor(val) {
  gainReadout.classList.remove('zone-cold', 'zone-warm', 'zone-hot', 'zone-danger');
  if (val > 300)      gainReadout.classList.add('zone-danger');
  else if (val > 200) gainReadout.classList.add('zone-hot');
  else if (val > 100) gainReadout.classList.add('zone-warm');
  else                gainReadout.classList.add('zone-cold');
}

function updateSliderFill() {
  const pct = (slider.value / slider.max) * 100;
  meterMask.style.width = (100 - pct) + '%';
}

function updateIntensityFill() {
  const pct = (intensitySlider.value / intensitySlider.max) * 100;
  intensityMask.style.width = (100 - pct) + '%';
}

function getActiveEffect() {
  const active = document.querySelector('.effect-btn.active');
  return active?.dataset.effect || 'none';
}

function getIntensity() {
  return parseInt(intensitySlider.value);
}

function setActiveEffect(effect) {
  effectBtns.forEach(b => b.classList.toggle('active', b.dataset.effect === effect));
  updateStatusDot(parseInt(slider.value), effect, getIntensity());
}

function updateStatusDot(vol, effect, intensity) {
  const engaged = (vol !== 100 || effect !== 'none' || intensity !== 100) && !bypassToggle.checked;
  statusDot.classList.toggle('active', engaged);
}

// ── Toolbar badge ─────────────────────────────────────────
function updateToolbarBadge(vol) {
  if (!currentTabId) return;
  try {
    if (badgeToggle.checked) {
      chrome.action.setBadgeText({ tabId: currentTabId, text: `${vol}%` });
      chrome.action.setBadgeBackgroundColor({ tabId: currentTabId, color: '#ffb454' });
    } else {
      chrome.action.setBadgeText({ tabId: currentTabId, text: '' });
    }
  } catch { /* badge API unavailable — ignore */ }
}

// ── Commit volume/effect/intensity ─────────────────────────
function commit(vol, effect, intensity) {
  saveState(vol, effect, intensity);
  applyToTab(vol, effect, intensity);
  updateStatusDot(vol, effect, intensity);
  updateToolbarBadge(vol);
}

// ── Load current site state ───────────────────────────────
async function loadState() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;

  currentTabId = tab.id;
  currentHost  = getHost(tab.url);
  siteBadge.textContent = currentHost || '—';

  const stored = await chrome.storage.local.get(currentHost);
  const state  = stored[currentHost] || { volume: 100, effect: 'none', intensity: 100, bypass: false, badge: false };
  const intensity = state.intensity ?? 100;

  slider.value = state.volume;
  volDisplay.textContent = state.volume;
  updateVolumeColor(state.volume);
  updateSliderFill();

  intensitySlider.value = intensity;
  intensityDisplay.textContent = (intensity / 100).toFixed(2);
  updateIntensityFill();

  setActiveEffect(state.effect);

  bypassToggle.checked = !!state.bypass;
  badgeToggle.checked  = !!state.badge;
  updateStatusDot(state.volume, state.effect, intensity);
  updateToolbarBadge(state.volume);
}

// ── Save state ────────────────────────────────────────────
async function saveState(volume, effect, intensity) {
  if (!currentHost) return;
  await chrome.storage.local.set({
    [currentHost]: {
      volume, effect, intensity,
      bypass: bypassToggle.checked,
      badge:  badgeToggle.checked,
    },
  });
}

// ── Send message to content script ───────────────────────
async function applyToTab(volume, effect, intensity) {
  if (!currentTabId) return;
  const payload = bypassToggle.checked
    ? { type: 'SOUND_ENHANCE', volume: 100, effect: 'none', intensity: 100 }
    : { type: 'SOUND_ENHANCE', volume, effect, intensity };
  try {
    await chrome.tabs.sendMessage(currentTabId, payload);
  } catch {
    // silent
  }
}

// ── [perf] スライダードラッグ中の間引き処理 ─────────────
// 'input' イベントはドラッグ中に非常に高頻度で発火する。そのたびに
// chrome.tabs.sendMessage と chrome.storage.local.set を呼ぶと、
// タブ側でエフェクトチェーンの再構築が連続して走り、サイトが
// 重くなったり落ちたりする原因になっていた（content.js/injected.js
// 側も併せて修正済み）。ここではさらに、そもそもの送信・保存回数
// 自体を間引くことで負荷を抑える。
//   ・タブへの送信: requestAnimationFrame で 1フレームにつき最大1回
//   ・ストレージ保存: ドラッグが止まってから確定して1回だけ保存
let pendingSend       = null;
let sendScheduled     = false;
let saveDebounceTimer = null;

function throttledApplyToTab(volume, effect, intensity) {
  pendingSend = { volume, effect, intensity };
  if (sendScheduled) return;
  sendScheduled = true;
  requestAnimationFrame(() => {
    sendScheduled = false;
    applyToTab(pendingSend.volume, pendingSend.effect, pendingSend.intensity);
  });
}

function debouncedSaveState(volume, effect, intensity) {
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => saveState(volume, effect, intensity), 200);
}

// ── Events ────────────────────────────────────────────────
slider.addEventListener('input', () => {
  const val = parseInt(slider.value);
  const effect = getActiveEffect();
  const intensity = getIntensity();
  volDisplay.textContent = val;
  updateVolumeColor(val);
  updateSliderFill();
  updateStatusDot(val, effect, intensity);
  updateToolbarBadge(val);
  // [perf] タブへの送信とストレージ保存を間引く
  throttledApplyToTab(val, effect, intensity);
  debouncedSaveState(val, effect, intensity);
});

// ドラッグ終了時（マウスアップ/キー確定等）に最新値を確実に保存・反映する
slider.addEventListener('change', () => {
  const val = parseInt(slider.value);
  const effect = getActiveEffect();
  const intensity = getIntensity();
  clearTimeout(saveDebounceTimer);
  saveState(val, effect, intensity);
  applyToTab(val, effect, intensity);
});

// Effect intensity slider — same drag-throttling treatment as the gain
// slider, since dragging it fires 'input' just as frequently.
intensitySlider.addEventListener('input', () => {
  const intensity = parseInt(intensitySlider.value);
  const vol = parseInt(slider.value);
  const effect = getActiveEffect();
  intensityDisplay.textContent = (intensity / 100).toFixed(2);
  updateIntensityFill();
  updateStatusDot(vol, effect, intensity);
  throttledApplyToTab(vol, effect, intensity);
  debouncedSaveState(vol, effect, intensity);
});

intensitySlider.addEventListener('change', () => {
  const intensity = parseInt(intensitySlider.value);
  const vol = parseInt(slider.value);
  const effect = getActiveEffect();
  clearTimeout(saveDebounceTimer);
  saveState(vol, effect, intensity);
  applyToTab(vol, effect, intensity);
});

effectBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const effect = btn.dataset.effect;
    setActiveEffect(effect);
    commit(parseInt(slider.value), effect, getIntensity());
  });
});

bypassToggle.addEventListener('change', () => {
  commit(parseInt(slider.value), getActiveEffect(), getIntensity());
});

badgeToggle.addEventListener('change', () => {
  saveState(parseInt(slider.value), getActiveEffect(), getIntensity());
  updateToolbarBadge(parseInt(slider.value));
});

resetBtn.addEventListener('click', async () => {
  slider.value = 100;
  volDisplay.textContent = '100';
  updateVolumeColor(100);
  updateSliderFill();

  intensitySlider.value = 100;
  intensityDisplay.textContent = '1.00';
  updateIntensityFill();

  setActiveEffect('none');
  bypassToggle.checked = false;
  badgeToggle.checked  = false;

  if (currentHost) {
    await chrome.storage.local.remove(currentHost);
  }
  // Send reset with volume 100, effect none, intensity 1.00x — do NOT send 0
  applyToTab(100, 'none', 100);
  updateToolbarBadge(100);
  statusDot.classList.remove('active');
});

// ── Init ──────────────────────────────────────────────────
loadState();
