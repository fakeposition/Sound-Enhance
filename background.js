// background.js — service worker v2.2
// 変更概要:
//   - sendMessage のリトライロジック追加（最大3回、指数バックオフ）
//   - エラーログを少し詳細に
//   [fix] TikTok の CSP により <script src> 方式の injected.js 注入が
//         ブロックされていたため、chrome.scripting.executeScript +
//         world:'MAIN' を用いたページワールド注入に変更。
//         CSP に依存しないため、TikTok の構造変更にも強い。
//   [fix] Spotify Web Player 対応: manifest.json に injected.js を
//         world:'MAIN' の content_script として document_start で宣言
//         注入するようにしたため、ここでの executeScript は「保険用の
//         フォールバック」に格下げ。従来は content.js からの
//         SOUND_ENHANCE_INJECT メッセージを待ってから注入していたが、
//         これは非同期でありページ側のスクリプトが先に AudioContext を
//         構築して .connect() してしまうレース条件があった
//         （Spotify は Widevine/EME で復号した音声を自前の Web Audio
//         グラフに流しており、MES は DRM により無音化されるため acx-only
//         方式＝この connect パッチに完全に依存している。パッチが後から
//         入ると最初の再生グラフを取り逃す）。
//         manifest 宣言注入は document_start で必ずページの他スクリプト
//         より先に走るため、このレースを構造的に解消できる。
//         injected.js 側は二重注入ガード(__soundEnhanceACXInstalled)を
//         持つため、ここでの再注入が走っても安全に no-op になる。

// ─────────────────────────────────────────────────────────
// [new] GitHub 経由の更新チェック
//   unpacked（開発者モード）拡張機能は Chrome の正式な自動更新機構
//   （ウェブストア経由の update_url）が使えないため、ここでは
//   「新しいバージョンが出ているかどうかを検知して知らせる」までを
//   自動化する。実ファイルの入れ替えはブラウザのセキュリティ上、
//   拡張機能自身が勝手に自分のインストールフォルダを書き換えることは
//   できないため、最終的な「zipを解凍してフォルダを置き換える」だけは
//   手動で行う必要がある。
//     ・ブラウザ起動時 (onStartup) と拡張機能の読み込み時 (onInstalled)
//       に自動チェック
//     ・chrome.alarms で6時間おきに定期チェック
//     ・popup 側から SOUND_ENHANCE_CHECK_UPDATE メッセージでも
//       オンデマンドでチェック可能
//   結果は chrome.storage.local の 'update_info' に保存し、popup が
//   それを読んでバッジ表示・ダウンロードボタン等に使う。
// ─────────────────────────────────────────────────────────
const UPDATE_GITHUB_OWNER  = 'fakeposition';
const UPDATE_GITHUB_REPO   = 'Sound-Enhance';
const UPDATE_GITHUB_BRANCH = 'main';
const UPDATE_MANIFEST_URL  = `https://raw.githubusercontent.com/${UPDATE_GITHUB_OWNER}/${UPDATE_GITHUB_REPO}/${UPDATE_GITHUB_BRANCH}/manifest.json`;
const UPDATE_ZIP_URL       = `https://codeload.github.com/${UPDATE_GITHUB_OWNER}/${UPDATE_GITHUB_REPO}/zip/refs/heads/${UPDATE_GITHUB_BRANCH}`;
const UPDATE_REPO_URL      = `https://github.com/${UPDATE_GITHUB_OWNER}/${UPDATE_GITHUB_REPO}`;
const UPDATE_ALARM_NAME    = 'sound-enhance-update-check';
const UPDATE_CHECK_INTERVAL_MIN = 360; // 6時間おき

// セマンティックバージョン比較。a > b なら 1、a < b なら -1、同じなら 0。
// "1.4.2" のような数値ドット区切りを想定（足りない桁は 0 扱い）。
function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

async function checkForUpdate() {
  const localVersion = chrome.runtime.getManifest().version;
  let info;
  try {
    const res = await fetch(UPDATE_MANIFEST_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const remoteManifest = await res.json();
    const remoteVersion  = remoteManifest.version;
    const available = typeof remoteVersion === 'string' && compareVersions(remoteVersion, localVersion) > 0;
    info = {
      localVersion,
      remoteVersion,
      available,
      zipUrl: UPDATE_ZIP_URL,
      repoUrl: UPDATE_REPO_URL,
      checkedAt: Date.now(),
      error: null,
    };
  } catch (e) {
    info = {
      localVersion,
      remoteVersion: null,
      available: false,
      zipUrl: UPDATE_ZIP_URL,
      repoUrl: UPDATE_REPO_URL,
      checkedAt: Date.now(),
      error: String(e),
    };
  }
  try { await chrome.storage.local.set({ update_info: info }); } catch { /* ignore */ }
  return info;
}

// 起動のたびに定期チェック用アラームを（再）登録
try {
  chrome.alarms.create(UPDATE_ALARM_NAME, { periodInMinutes: UPDATE_CHECK_INTERVAL_MIN });
} catch { /* ignore */ }

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM_NAME) checkForUpdate();
});

chrome.runtime.onStartup.addListener(() => checkForUpdate());
chrome.runtime.onInstalled.addListener(() => checkForUpdate());

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'SOUND_ENHANCE_CHECK_UPDATE') return;
  checkForUpdate().then(sendResponse);
  return true; // async response
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'SOUND_ENHANCE_INJECT') return;

  const tabId = sender.tab?.id;
  const frameId = sender.frameId;
  if (tabId === undefined) { sendResponse?.({ ok: false }); return; }

  chrome.scripting.executeScript({
    target: { tabId, frameIds: frameId !== undefined ? [frameId] : undefined },
    files: ['injected.js'],
    world: 'MAIN',
    injectImmediately: true,
  }).then(() => {
    sendResponse?.({ ok: true });
  }).catch((e) => {
    console.debug('[SoundEnhance background] executeScript failed:', e);
    sendResponse?.({ ok: false, error: String(e) });
  });

  return true; // async response
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;

  let host;
  try { host = new URL(tab.url).hostname; }
  catch { return; }

  let data, state;
  try {
    data  = await chrome.storage.local.get(host);
    state = data[host];
  } catch (e) { return; }

  if (!state) return;

  // バイパス中はページへ 100%/none/1.00x を送るが、保存済みプリセットには触れない
  const sendVolume    = state.bypass ? 100    : state.volume;
  const sendEffect    = state.bypass ? 'none' : state.effect;
  const sendIntensity = state.bypass ? 100    : (state.intensity ?? 100);

  // ツールバーバッジ（有効なら現在のゲインを表示）
  try {
    if (state.badge) {
      chrome.action.setBadgeText({ tabId, text: `${sendVolume}%` });
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#ffb454' });
    } else {
      chrome.action.setBadgeText({ tabId, text: '' });
    }
  } catch { /* ignore */ }

  // 指数バックオフでリトライ（content script の準備を待つ）
  const delays = [800, 2000, 4000];
  for (const delay of delays) {
    await new Promise(r => setTimeout(r, delay));
    try {
      await chrome.tabs.sendMessage(tabId, {
        type:      'SOUND_ENHANCE',
        volume:    sendVolume,
        effect:    sendEffect,
        intensity: sendIntensity,
      });
      break; // 成功したらループを抜ける
    } catch {
      // Content script がまだ準備できていない — 次のリトライへ
    }
  }
});
