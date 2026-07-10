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