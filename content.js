// content.js — v2.1 TikTok対応強化
// 変更概要（v2.0 からの差分）:
//   [fix] acx-only サイト（TikTok等）で volume/effect が一切反映されていなかったバグを修正
//         → acx-only でも sendToPage() は必ず呼び、injected.js の ACX チェーンへ転送する
//   [fix] TikTok の Shadow DOM 内 <video> を MutationObserver が見逃す問題を修正
//         → 初期化時に既存 Shadow Root を再帰的にすべて observe する
//   [fix] injected.js スクリプト挿入の非同期性により ACX パッチが間に合わない問題を修正
//         → onload 後に sendToPage() で現在の設定を再送し、さらに短期ポーリングで補完
//   [fix] TikTok SPA遷移後に状態が消える問題を修正
//         → popstate / pushState / replaceState をフックして restoreState を再実行
//   [new] TikTok の video element は src が後から設定されることが多いため
//         'loadedmetadata' イベントでも hookAllMedia を呼ぶ
//   [new] video/audio の play イベントでも sendToPage して ACX チェーンを起こす

(function () {
  'use strict';

  // ── サイト戦略マップ ──────────────────────────────────
  // [fix] soundcloud.com: 'acx-patch' → 'acx-only' に変更。
  //       SoundCloud の音声CDNはCORSヘッダーを返さないため、
  //       crossOrigin='anonymous' を設定して createMediaElementSource
  //       に接続すると例外を投げずに音声が無音化(tainted)される。
  //       catch節でしかACXへフォールバックしない実装のため、この
  //       無音化ケースでは永久にMESのまま＝音が一切出なくなっていた。
  //       MESを最初から試みない acx-only にすることで回避する。
  // [fix] open.spotify.com: acx-only。
  //       Web Playback SDK は Widevine(EME) で復号した音声を自前の
  //       Web Audio グラフに流している。EME で MediaKeys が設定された
  //       <audio> 要素に createMediaElementSource() を呼ぶと、DRM保護の
  //       ため出力が無音化(tainted)される仕様のため MES は最初から使えない。
  //       injected.js の AudioNode.connect パッチ（ページ自身の
  //       AudioContext を横取り）だけが有効な経路 …… という想定だったが、
  //       実機確認の結果 Netflix / Spotify では acx-only でも音が変わらない
  //       ことが判明した。
  //   [fix] Netflix / Spotify: 'acx-only' → 'tabcapture' に変更。
  //       Netflix は多くの場合ページがWeb Audioグラフを自前で構築せず、
  //       ブラウザが復号済み音声を <video> 要素へ直接流し込むだけのため、
  //       ACXパッチがフックする対象のグラフがそもそも存在しない。
  //       Spotifyは独自のWeb Audioグラフを構築するが、EME/DRM保護された
  //       音声をWeb Audio経由で加工しようとするとブラウザ側の保護機構で
  //       無音化/ブロックされることがある。
  //       いずれもページ内部の音声処理構造に依存しない chrome.tabCapture
  //       方式（background.js / offscreen.js 側で実装）に切り替えることで
  //       対応する。'tabcapture' 指定のサイトでは、この content.js は
  //       MES/ACXを一切試みず、popupからの音量/エフェクト変更をそのまま
  //       background.js へ転送するだけになる。
  const SITE_STRATEGIES = {
    'tiktok.com':        { method: 'acx-adaptive', shadowDom: true  },
    'instagram.com':     { method: 'acx-only',      shadowDom: true  },
    'facebook.com':      { method: 'acx-only',      shadowDom: true  },
    'soundcloud.com':    { method: 'acx-only',      shadowDom: false },
    'open.spotify.com':  { method: 'tabcapture',    shadowDom: false },
    'music.youtube.com': { method: 'mes-with-cors', shadowDom: false },
    'youtube.com':       { method: 'mes-with-cors', shadowDom: false },
    'twitch.tv':         { method: 'acx-patch',     shadowDom: false },
    'netflix.com':       { method: 'tabcapture',    shadowDom: false },
    'primevideo.com':    { method: 'acx-only',      shadowDom: false },
    'amazon.co.jp':      { method: 'acx-only',      shadowDom: false },
    'nicovideo.jp':      { method: 'mes-with-cors', shadowDom: false },
    'abema.tv':          { method: 'acx-patch',     shadowDom: false },
    'radiko.jp':         { method: 'mes-with-cors', shadowDom: false },
    'dazn.com':          { method: 'acx-patch',     shadowDom: false },
    'music.apple.com':   { method: 'acx-only',      shadowDom: false },
    'x.com':             { method: 'auto',           shadowDom: false },
    'twitter.com':       { method: 'auto',           shadowDom: false },
    'bilibili.com':      { method: 'acx-patch',     shadowDom: false },
    'discord.com':       { method: 'mes-only',       shadowDom: false, excludeInteractive: true },
  };

  function getStrategy(hostname) {
    for (const [domain, strategy] of Object.entries(SITE_STRATEGIES)) {
      if (hostname === domain || hostname.endsWith('.' + domain)) return strategy;
    }
    return { method: 'auto', shadowDom: false };
  }

  const strategy = getStrategy(location.hostname);

  // ── injected.js をページワールドに挿入 ───────────────
  let injectedReady = false;
  let pendingApply  = null; // injected.js ロード前に届いたメッセージをバッファ

  function injectPageScript() {
    // ── 【TikTok修正・根本原因】<script src> 方式は TikTok の CSP
    // (script-src) によりブロックされ injected.js が一切実行されない。
    // chrome.scripting.executeScript + world:'MAIN' は CSP を経由せず
    // ページのJSコンテキストへ直接コードを注入できるため、
    // TikTok側のDOM/CSP構造が変わっても影響を受けない。
    try {
      chrome.runtime.sendMessage({ type: 'SOUND_ENHANCE_INJECT' }, () => {
        // background.js が executeScript を実行する。
        // 完了通知は __soundEnhanceInjected カスタムイベントで受け取る。
      });
    } catch (e) {
      console.debug('[SoundEnhance content] injectPageScript error:', e);
    }
  }

  // injected.js が実際にページワールドへ注入完了したことを通知するイベント
  window.addEventListener('__soundEnhanceInjected', () => {
    injectedReady = true;
    if (pendingApply) {
      sendToPage(pendingApply.volume, pendingApply.effect, pendingApply.intensity);
      pendingApply = null;
    }
    reapplyCurrentState();
  }, { once: true, passive: true });

  // ── 【TikTok修正】通知イベントを取り損ねた場合のフォールバック ──
  // executeScript は通常 documentEnd 前に完了するが、稀にイベント
  // 配送タイミングを取り損ねることがあるため、一定時間後に
  // injectedReady を強制的に true にして送信を試みる。
  setTimeout(() => {
    if (!injectedReady) {
      injectedReady = true;
      if (pendingApply) {
        sendToPage(pendingApply.volume, pendingApply.effect, pendingApply.intensity);
        pendingApply = null;
      }
      reapplyCurrentState();
    }
  }, 1500);

  injectPageScript();

  // ── content.js -> injected.js 通信 ───────────────────
  function sendToPage(volume, effect, intensity) {
    if (!injectedReady) {
      // まだロードされていなければバッファ（後で onload から送る）
      pendingApply = { volume, effect, intensity };
      return;
    }
    try {
      window.dispatchEvent(new CustomEvent('__soundEnhanceApply', {
        detail: { volume, effect, intensity }
      }));
    } catch (e) { /* ignore */ }
  }

  // ── Safe wrapper ──────────────────────────────────────
  function safe(fn, label) {
    try { return fn(); }
    catch (e) { console.debug('[SoundEnhance content]', label, e); }
  }

  // ── MediaElement フォールバックチェーン ───────────────
  const elementChains = new WeakMap();
  const connected     = new WeakSet();
  const failedEls     = new WeakSet();
  let   audioCtx      = null;
  let   currentEffect = 'none';
  let   currentVolume = 100;
  let   currentIntensity = 100; // 100 = 1.00x (default/current behavior), 0–300 range

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // 現在のメソッドを追跡（popup 表示用）
  let activeMethod = 'unknown';

  function getCtx() {
    if (!audioCtx || audioCtx.state === 'closed') {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) { return null; }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      safe(() => audioCtx.resume(), 'resume ctx');
    }
    return audioCtx;
  }

  function createImpulse(ctx, duration, decay, reverse) {
    const rate   = ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * duration));
    try {
      const impulse = ctx.createBuffer(2, length, rate);
      for (let c = 0; c < 2; c++) {
        const ch = impulse.getChannelData(c);
        for (let i = 0; i < length; i++) {
          const n   = reverse ? length - i : i;
          const env = Math.pow(1 - n / length, decay);
          ch[i] = (Math.random() * 2 - 1) * env * 0.5
                + (Math.random() * 2 - 1) * env * 0.3
                + (Math.random() * 2 - 1) * env * 0.2;
        }
      }
      return impulse;
    } catch (e) { return null; }
  }

  function buildChain(ctx, source) {
    const bassFilter   = ctx.createBiquadFilter();
    bassFilter.type    = 'lowshelf';
    bassFilter.frequency.value = 200;
    bassFilter.gain.value = 0;

    const trebleFilter   = ctx.createBiquadFilter();
    trebleFilter.type    = 'highshelf';
    trebleFilter.frequency.value = 3000;
    trebleFilter.gain.value = 0;

    const pannerNode = ctx.createStereoPanner();
    pannerNode.pan.value = 0;

    const dryGainNode  = ctx.createGain();
    dryGainNode.gain.value = 1;
    const wetGainNode  = ctx.createGain();
    wetGainNode.gain.value = 0;
    const gainNode     = ctx.createGain();
    gainNode.gain.value = currentVolume / 100;

    source.connect(bassFilter);
    bassFilter.connect(trebleFilter);
    trebleFilter.connect(pannerNode);
    pannerNode.connect(dryGainNode);
    dryGainNode.connect(gainNode);
    wetGainNode.connect(gainNode);
    gainNode.connect(ctx.destination);

    return {
      bassFilter, trebleFilter, pannerNode,
      dryGainNode, wetGainNode, gainNode,
      convolverNode: null, panInterval: null,
    };
  }

  // ── Shadow DOM を再帰的に探索 ────────────────────────
  function collectMediaElements(root) {
    const results = [];
    safe(() => {
      root.querySelectorAll('video, audio').forEach(el => results.push(el));
      if (strategy.shadowDom) {
        root.querySelectorAll('*').forEach(el => {
          if (el.shadowRoot) results.push(...collectMediaElements(el.shadowRoot));
        });
      }
    }, 'collectMediaElements');
    return results;
  }

  // ── 【TikTok修正】Shadow Root を再帰的に observe ──────
  // ページロード時点で既に存在している Shadow Root は
  // MutationObserver のコールバックで shadowRoot が見つかった時だけでは
  // 登録されないため、初期化時に全 Shadow Root を走査して observe する。
  function observeExistingShadowRoots(root) {
    if (!strategy.shadowDom) return;
    safe(() => {
      root.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) {
          observer.observe(el.shadowRoot, { childList: true, subtree: true });
          observeExistingShadowRoots(el.shadowRoot); // 再帰
        }
      });
    }, 'observeExistingShadowRoots');
  }

  // ── [new] tabcapture 方式のヘルパー ────────────────────
  // 音声処理は一切ここで行わず、background.js -> offscreen.js に丸投げする。
  function isTabCapture() { return strategy.method === 'tabcapture'; }

  function sendTabCaptureUpdate(volume, effect, intensity) {
    safe(() => {
      chrome.runtime.sendMessage({
        type: 'SOUND_ENHANCE_TABCAPTURE_UPDATE',
        volume, effect, intensity,
      }).catch(() => { /* background/offscreen 未準備等は無視 */ });
    }, 'sendTabCaptureUpdate');
  }

  function connectElement(el) {
    if (connected.has(el) || failedEls.has(el)) return;

    // tabcapture サイトでは MES/ACX を一切試みない
    // （chrome.tabCapture がタブ音声を丸ごと処理するため不要かつ無意味）
    if (isTabCapture()) {
      connected.add(el);
      activeMethod = 'TabCapture';
      return;
    }

    // ── 【TikTok修正】acx-only でも play イベントを監視 ──
    // acx-only サイトは injected.js の ACX パッチに依存するが、
    // video が play されたタイミングで sendToPage を呼んで
    // 確実に ACX チェーンへ設定を届ける。
    if (!el.__soundEnhancePlayHooked) {
      el.__soundEnhancePlayHooked = true;
      el.addEventListener('play', () => {
        sendToPage(currentVolume, currentEffect, currentIntensity);
      }, { passive: true });
      el.addEventListener('loadedmetadata', () => {
        hookAllMedia();
        sendToPage(currentVolume, currentEffect, currentIntensity);
      }, { passive: true });
    }

    const method = strategy.method;

    // acx-only: createMediaElementSource を一切試みない
    if (method === 'acx-only') {
      connected.add(el);
      activeMethod = 'ACX';
      return;
    }

    // ── 【TikTok修正】acx-adaptive ──────────────────────
    // TikTok等は MSE (srcObject = MediaSource / currentSrc = blob:) で配信されることが多く、
    // blob: はページと同一オリジン扱いのため createMediaElementSource は無音化しない。
    // 一方、直接クロスオリジンURL（CDN直リンク）の場合は MES で無音化する恐れがあるため
    // ACX のみにフォールバックする。
    // currentSrc/srcObject がまだ未設定（読み込み前）の場合は connected に加えず、
    // 次の play/loadedmetadata イベントで再判定する。
    if (method === 'acx-adaptive') {
      const src = el.currentSrc || el.src || '';
      const isSameOriginMedia = !!el.srcObject || src.startsWith('blob:') || src.startsWith(location.origin);
      if (!src && !el.srcObject) {
        // まだソース未確定 — 後続イベントで再評価
        return;
      }
      if (!isSameOriginMedia) {
        // クロスオリジン直リンク — MES は無音化リスクがあるため ACX のみ
        connected.add(el);
        activeMethod = activeMethod === 'MES' ? activeMethod : 'ACX';
        return;
      }
      // 同一オリジン（MSE/blob）— MES を試みる（下の通常フローへ）
    }

    const ctx = getCtx();
    if (!ctx) return;

    connected.add(el);

    safe(() => {
      // mes-with-cors / mes-only / acx-patch / auto / acx-adaptive(blob): crossOrigin を設定してから試みる
      if (method === 'mes-with-cors' || method === 'auto' || method === 'acx-patch' || method === 'mes-only' || method === 'acx-adaptive') {
        if (!el.crossOrigin) el.crossOrigin = 'anonymous';
      }

      try {
        const source = ctx.createMediaElementSource(el);
        const chain = buildChain(ctx, source);
        elementChains.set(el, chain);
        activeMethod = 'MES';
        // [perf] 新規チェーンを現在のエフェクト/音量に同期する。
        // グローバルの applyEffect() は「変化があった時」しか全チェーンへ
        // ブロードキャストしないため、後から生成されたチェーンはここで
        // 個別に初期化しておく必要がある。
        safe(() => applyEffectToSingleChain(ctx, chain, currentEffect, currentIntensity), 'init new chain effect');
        safe(() => applyVolumeToSingleChain(ctx, chain, currentVolume, currentEffect), 'init new chain volume');
      } catch (e) {
        // 失敗した場合の処理
        failedEls.add(el);
        if (method === 'auto' || method === 'acx-patch' || method === 'acx-adaptive') {
          // ACX パッチにフォールバック（injected.js が担当）
          activeMethod = activeMethod === 'MES' ? activeMethod : 'ACX';
          console.debug('[SoundEnhance content] MES failed, falling back to ACX patch', e);
        }
        // mes-only サイト（Discord）は再試行しない
      }
    }, 'connectElement');
  }

  function getAllChains() {
    const chains = [];
    safe(() => {
      collectMediaElements(document).forEach(el => {
        if (elementChains.has(el)) chains.push(elementChains.get(el));
      });
    }, 'getAllChains');
    return chains;
  }

  // [perf] インパルス応答バッファのキャッシュ。
  // duration/decay はエフェクトの「形」を決めるパラメータで、強度(intensity)
  // では変わらない。強度が変えるのは wet/dry/treble 等の“ミックス量”だけ。
  // 以前は setupReverb() のたびにこの重いバッファ（数十万サンプルを
  // Math.random()+Math.pow() で生成）を毎回作り直しており、これが強度
  // スライダーをドラッグした時（1秒間に最大60回 applyEffect が走る）の
  // 重さ・クラッシュの主因だった。同じ形状のバッファは AudioContext ごとに
  // 一度だけ生成してキャッシュし、以後は使い回す。
  const impulseCache = new WeakMap(); // ctx -> Map(key -> AudioBuffer)

  function getImpulse(ctx, duration, decay, reverse) {
    let map = impulseCache.get(ctx);
    if (!map) { map = new Map(); impulseCache.set(ctx, map); }
    const key = duration + '_' + decay + '_' + (reverse ? 1 : 0);
    if (map.has(key)) return map.get(key);
    const buf = createImpulse(ctx, duration, decay, reverse);
    map.set(key, buf); // 失敗時は null をキャッシュし、無駄な再試行もしない
    return buf;
  }

  function setupReverb(ctx, chain, duration, decay, wetLevel, trebleBoost, reverse) {
    safe(() => {
      // [perf] コンボルバーノードはチェーンごとに一度だけ作り、以後は
      // 使い回す（毎回 disconnect → 再生成 → 再接続すると、強度ドラッグ中に
      // ノード生成・グラフ再構築が連発してタブが重くなっていた）。
      // 鳴らさない時は wetGainNode を 0 にするだけで無音になるので、
      // ノード自体は繋ぎっぱなしで問題ない。
      if (!chain.convolverNode) {
        const conv = ctx.createConvolver();
        chain.pannerNode.connect(conv);
        conv.connect(chain.wetGainNode);
        chain.convolverNode = conv;
        chain.convolverKey = null;
      }
      const key = duration + '_' + decay + '_' + (reverse ? 1 : 0);
      if (chain.convolverKey !== key) {
        const buf = getImpulse(ctx, duration, decay, reverse);
        if (buf) {
          chain.convolverNode.buffer = buf;
          chain.convolverKey = key;
        }
      }
      chain.wetGainNode.gain.setTargetAtTime(wetLevel, ctx.currentTime, 0.05);
      chain.trebleFilter.gain.value = trebleBoost;
    }, 'setupReverb');
  }

  // [perf] 音量スライダーを素早く動かした時などに、エフェクト自体は
  // 変わっていないのにリバーブの再生成やパン用 setInterval の再起動を
  // 繰り返してタブが重くなる/クラッシュする問題への対策。
  //   ・チェーン1本分のエフェクト適用処理を applyEffectToSingleChain に分離
  //   ・音量の comp（かさ増し係数）計算を getVolumeComp に分離
  //   ・applyEffect() は「直前と同じエフェクト」なら即座に抜けるようにし、
  //     音量だけの高速な変更では重い処理が一切走らないようにする
  function getVolumeComp(effect) {
    switch (effect) {
      case 'live':    return 1.18;
      case 'reverb':  return 1.1;
      case 'water':   return 1.1;
      case 'stadium': return 1.15;
      case 'loud':    return 1.15;
      case '16d':     return 1.08;
      case '8d':      return 1.05;
      case 'lofi':    return 0.95;
      case 'vacuum':  return 1.12;
      default:        return 1;
    }
  }

  // パンを周期的に揺らすエフェクト一覧（強度変更のたびにタイマーを
  // 張り直さないよう、対象かどうかの判定に使う）
  const PAN_EFFECTS = { '3d': 1, '8d': 1, '16d': 1, 'water': 1, 'outdoor': 1, 'vacuum': 1 };

  function applyEffectToSingleChain(ctx, chain, effect, intensity) {
    const mult = (intensity ?? 100) / 100; // 1.0 = デフォルト（従来通り）の強度

    // [perf] パン系エフェクトのままなら setInterval は張り直さない。
    // 以前は強度スライダーをドラッグするたびに毎フレーム
    // clearInterval → setInterval を繰り返しており、タイマー生成が
    // 過多になっていた。エフェクト自体が変わった時だけ startPan() 内で
    // 張り替え、強度だけの変更では振幅(chain.panAmp)を更新するのみ。
    if (!PAN_EFFECTS[effect] && chain.panInterval) {
      clearInterval(chain.panInterval);
      chain.panInterval = null;
      chain.panKey = null;
    }

    safe(() => {
      chain.bassFilter.gain.value = 0;
      chain.trebleFilter.gain.value = 0;
      // [fix] call/lofi はシェルフ周波数自体をずらして効果を強めるため、
      // 他エフェクトに切り替わった時にデフォルト周波数へ戻す。
      chain.bassFilter.frequency.value = 200;
      chain.trebleFilter.frequency.value = 3000;
      if (!PAN_EFFECTS[effect]) chain.pannerNode.pan.setTargetAtTime(0, ctx.currentTime, 0.02);
      chain.dryGainNode.gain.setTargetAtTime(1, ctx.currentTime, 0.02);
      chain.wetGainNode.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      // [perf] convolverNode はここでは破棄しない。setupReverb() が
      // ノードを使い回し、wetGainNode=0 で無音化されるので十分。
    }, 'reset chain');

    function startPan(key, speed, intervalMs) {
      if (chain.panKey === key) return; // 同じパン系エフェクト継続中はタイマーそのまま
      if (chain.panInterval) clearInterval(chain.panInterval);
      chain.panAngle = 0;
      chain.panKey = key;
      chain.panInterval = setInterval(() => {
        chain.panAngle += speed;
        safe(() => { chain.pannerNode.pan.value = Math.sin(chain.panAngle) * chain.panAmp; }, 'pan-' + key);
      }, intervalMs);
    }

    switch (effect) {
      case '3d': {
        const wet = clamp(0.18 * mult, 0, 0.9);
        const treble = clamp(1 * mult, -24, 24);
        const dry = clamp(1 - 0.12 * (mult - 1), 0.3, 1);
        chain.panAmp = clamp(0.95 * mult, 0, 1);
        setupReverb(ctx, chain, 1.2, 4, wet, treble, false);
        chain.dryGainNode.gain.setTargetAtTime(dry, ctx.currentTime, 0.05);
        startPan('3d', 0.022, 30);
        break;
      }
      case '8d': {
        const wet = clamp(0.22 * mult, 0, 0.9);
        const treble = clamp(1.5 * mult, -24, 24);
        const dry = clamp(1 - 0.15 * (mult - 1), 0.3, 1);
        chain.panAmp = clamp(0.95 * mult, 0, 1);
        setupReverb(ctx, chain, 1.8, 3.5, wet, treble, false);
        chain.dryGainNode.gain.setTargetAtTime(dry, ctx.currentTime, 0.05);
        startPan('8d', 0.048, 30);
        break;
      }
      case '16d': {
        const wet = clamp(0.25 * mult, 0, 0.9);
        const treble = clamp(2 * mult, -24, 24);
        const dry = clamp(1 - 0.18 * (mult - 1), 0.3, 1);
        chain.panAmp = clamp(0.95 * mult, 0, 1);
        setupReverb(ctx, chain, 2.0, 3, wet, treble, false);
        chain.dryGainNode.gain.setTargetAtTime(dry, ctx.currentTime, 0.05);
        startPan('16d', 0.1, 30);
        break;
      }
      case 'live': {
        const wet = clamp(0.55 * mult, 0, 0.9);
        const treble = clamp(6 * mult, -24, 24);
        const bass = clamp(3 * mult, -24, 24);
        const dry = clamp(1 - 0.16 * (mult - 1), 0.2, 1);
        setupReverb(ctx, chain, 2.8, 2.0, wet, treble, false);
        chain.dryGainNode.gain.setTargetAtTime(dry, ctx.currentTime, 0.05);
        chain.bassFilter.gain.value = bass;
        chain.trebleFilter.gain.value = treble;
        break;
      }
      case 'bass':
        chain.bassFilter.gain.value = clamp(12 * mult, -24, 24);
        chain.trebleFilter.gain.value = clamp(-1 * mult, -24, 24);
        break;
      case 'treble':
        chain.trebleFilter.gain.value = clamp(12 * mult, -24, 24);
        chain.bassFilter.gain.value = clamp(-1 * mult, -24, 24);
        break;
      case 'vocal':
        // カット低域・持ち上げ高域で音声の明瞭度を上げる（電話/実況向け）
        chain.bassFilter.gain.value = clamp(-8 * mult, -24, 24);
        chain.trebleFilter.gain.value = clamp(7 * mult, -24, 24);
        break;
      case 'loud':
        // フィルターは素通しのまま、後段の comp ブーストのみで底上げ
        chain.bassFilter.gain.value = clamp(2 * mult, -24, 24);
        chain.trebleFilter.gain.value = clamp(1 * mult, -24, 24);
        break;
      case 'reverb': {
        const wet = clamp(0.38 * mult, 0, 0.9);
        const dry = clamp(1 - 0.24 * (mult - 1), 0.2, 1);
        setupReverb(ctx, chain, 3.0, 2.5, wet, 0, false);
        chain.dryGainNode.gain.setTargetAtTime(dry, ctx.currentTime, 0.05);
        break;
      }
      case 'night':
        chain.trebleFilter.gain.value = clamp(-7 * mult, -24, 24);
        chain.bassFilter.gain.value = clamp(4 * mult, -24, 24);
        break;
      case 'water': {
        const treble = clamp(-18 * mult, -24, 24);
        const bass = clamp(6 * mult, -24, 24);
        const wet = clamp(0.55 * mult, 0, 0.9);
        const dry = clamp(1 - 0.44 * (mult - 1), 0.15, 1);
        chain.panAmp = clamp(0.3 * mult, 0, 1);
        chain.trebleFilter.gain.value = treble;
        chain.bassFilter.gain.value = bass;
        setupReverb(ctx, chain, 4.0, 1.8, wet, -12, false);
        chain.dryGainNode.gain.setTargetAtTime(dry, ctx.currentTime, 0.05);
        startPan('water', 0.008, 30);
        break;
      }

      // ── [new] 屋外 ── 壁のない開けた空間を想定。低域の膨らみを抑え、
      // 高域は距離による空気減衰でわずかに丸め、反射音はごく薄く短くする。
      // 定位もそよ風のようにゆっくり揺らす。
      case 'outdoor': {
        // [tune] flat との差が乏しいとの指摘を受けて全体的にパラメータを強化。
        // 低域の抜け・高域の減衰・残響・パンの揺れをそれぞれ約2倍前後に。
        const bass = clamp(-7 * mult, -24, 24);
        const treble = clamp(-6 * mult, -24, 24);
        const wet = clamp(0.2 * mult, 0, 0.9);
        const dry = clamp(1 - 0.14 * (mult - 1), 0.4, 1);
        chain.panAmp = clamp(0.34 * mult, 0, 1);
        chain.bassFilter.gain.value = bass;
        chain.trebleFilter.gain.value = treble;
        setupReverb(ctx, chain, 0.9, 5, wet, -7, false);
        chain.dryGainNode.gain.setTargetAtTime(dry, ctx.currentTime, 0.05);
        startPan('outdoor', 0.007, 55);
        break;
      }

      // ── [new] スタジアム ── 巨大空間特有の長い残響と観客席のロー感。
      case 'stadium': {
        const bass = clamp(5 * mult, -24, 24);
        const treble = clamp(-2 * mult, -24, 24);
        const wet = clamp(0.5 * mult, 0, 0.9);
        const dry = clamp(1 - 0.34 * (mult - 1), 0.15, 1);
        chain.bassFilter.gain.value = bass;
        chain.trebleFilter.gain.value = treble;
        setupReverb(ctx, chain, 3.5, 1.5, wet, -2, false);
        chain.dryGainNode.gain.setTargetAtTime(dry, ctx.currentTime, 0.05);
        break;
      }

      // ── [new] 通話/ポッドキャスト ── 低域を大胆にカットし、
      // 高域の明瞭感を上げて声の聞き取りやすさを最優先。
      case 'call':
        // [tune] シェルフのカット/ブースト量を増やすだけでなく、
        // 周波数ポイント自体を寄せてバンドを狭め、電話/通話らしい
        // 「痩せた」明瞭感がはっきり分かるようにした。
        chain.bassFilter.frequency.value = 350;
        chain.trebleFilter.frequency.value = 2200;
        chain.bassFilter.gain.value = clamp(-20 * mult, -24, 24);
        chain.trebleFilter.gain.value = clamp(6 * mult, -24, 24);
        break;

      // ── [new] Lo-Fi/レトロ ── 高域を丸め低域をふくよかにし、
      // ごく薄いアンビエンスでヴィンテージ機材の質感を再現。
      case 'lofi': {
        // [tune] 高域の丸め幅・低域の膨らみ・アンビエンス量を全体的に強化し、
        // ヴィンテージ機材の質感がより明確に出るようにした。
        // trebleFilter の周波数も下げ、こもり感の立ち上がりを早める。
        chain.trebleFilter.frequency.value = 2200;
        const treble = clamp(-16 * mult, -24, 24);
        const bass = clamp(6 * mult, -24, 24);
        const wet = clamp(0.2 * mult, 0, 0.9);
        const dry = clamp(1 - 0.2 * (mult - 1), 0.3, 1);
        chain.trebleFilter.gain.value = treble;
        chain.bassFilter.gain.value = bass;
        setupReverb(ctx, chain, 0.8, 4.5, wet, -8, false);
        chain.dryGainNode.gain.setTargetAtTime(dry, ctx.currentTime, 0.05);
        break;
      }

      // ── [new] 真空/宇宙 ── 空気のない広大な空間を想定。無線交信のように
      // 高域を大きく削って音をこもらせつつ、金属カプセル内の低い共鳴感を
      // わずかに足す。巨大で減衰の遅い暗いリバーブで果てしない空間の広がりを
      // 表現し、定位は無重力の中をゆっくり漂うように揺らす。
      case 'vacuum': {
        const bass = clamp(4 * mult, -24, 24);
        const treble = clamp(-9 * mult, -24, 24);
        const wet = clamp(0.5 * mult, 0, 0.9);
        const dry = clamp(1 - 0.4 * (mult - 1), 0.15, 1);
        chain.panAmp = clamp(0.18 * mult, 0, 1);
        chain.bassFilter.gain.value = bass;
        chain.trebleFilter.gain.value = treble;
        setupReverb(ctx, chain, 6.0, 1.1, wet, -10, false);
        chain.dryGainNode.gain.setTargetAtTime(dry, ctx.currentTime, 0.05);
        startPan('vacuum', 0.003, 70);
        break;
      }

      // mono/none は連続パラメータを持たないため、強度の影響を受けない
      case 'mono':
      case 'none':
      default:
        break;
    }
  }

  let lastGlobalEffect    = 'none';
  let lastGlobalIntensity = 100;

  function applyEffect(effect, intensity) {
    currentEffect = effect;
    const eff = intensity ?? currentIntensity;
    if (effect === lastGlobalEffect && eff === lastGlobalIntensity) return; // [perf] 変化がなければ何もしない
    lastGlobalEffect = effect;
    lastGlobalIntensity = eff;

    const chains = getAllChains();
    if (chains.length === 0) return;
    const ctx = getCtx();
    if (!ctx) return;
    chains.forEach(chain => applyEffectToSingleChain(ctx, chain, effect, eff));
  }

  function applyVolumeToSingleChain(ctx, chain, volumePct, effect) {
    const comp = getVolumeComp(effect);
    safe(() => chain.gainNode.gain.setTargetAtTime((volumePct / 100) * comp, ctx.currentTime, 0.02), 'applyVol');
  }

  function applyVolume(volumePct) {
    currentVolume = volumePct;
    const chains = getAllChains();
    if (chains.length === 0) return;
    const ctx = getCtx();
    if (!ctx) return;
    chains.forEach(chain => applyVolumeToSingleChain(ctx, chain, volumePct, currentEffect));
  }

  // ── メディア要素のフック ──────────────────────────────
  function hookAllMedia() {
    safe(() => {
      collectMediaElements(document).forEach(el => {
        if (!connected.has(el) && !failedEls.has(el)) connectElement(el);
      });
    }, 'hookAllMedia');
  }

  // MutationObserver: DOM変化を監視（Shadow Root も観察）
  const observer = new MutationObserver((mutations) => {
    safe(() => {
      let hasRelevant = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) { // Element
            hasRelevant = true;
            // Shadow Root を持つ要素を追加観察
            if (node.shadowRoot && strategy.shadowDom) {
              observer.observe(node.shadowRoot, { childList: true, subtree: true });
              // ── 【TikTok修正】新規追加要素の Shadow Root も再帰的に observe
              observeExistingShadowRoots(node.shadowRoot);
            }
          }
        }
      }
      if (hasRelevant) hookAllMedia();
    }, 'MutationObserver hook');
  });
  safe(() => observer.observe(document.documentElement, { childList: true, subtree: true }), 'observer start');

  // ── 【TikTok修正】既存 Shadow Root の初期 observe ──────
  // DOM が document_start の時点では body がないこともあるため
  // DOMContentLoaded 後に確実に走査する
  function initShadowObserve() {
    observeExistingShadowRoots(document.documentElement);
    hookAllMedia();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initShadowObserve, { once: true });
  } else {
    initShadowObserve();
  }

  // iframe内も探索（クロスオリジンは無視）
  function hookIframes() {
    safe(() => {
      document.querySelectorAll('iframe').forEach(iframe => {
        try {
          const doc = iframe.contentDocument;
          if (!doc) return;
          doc.querySelectorAll('video, audio').forEach(el => {
            if (!connected.has(el) && !failedEls.has(el)) connectElement(el);
          });
        } catch { /* cross-origin: ignore */ }
      });
    }, 'hookIframes');
  }
  setInterval(hookIframes, 3000);

  // ユーザー操作でAudioContextを起こす
  document.addEventListener('click', () => {
    safe(() => {
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      hookAllMedia();
      // ── 【TikTok修正】クリック時も必ず sendToPage して ACX チェーンを起こす
      if (currentVolume !== 100 || currentEffect !== 'none' || currentIntensity !== 100) {
        sendToPage(currentVolume, currentEffect, currentIntensity);
      }
    }, 'click hook');
  }, { passive: true });

  // ── 現在の設定を injected.js に再適用 ─────────────────
  // injected.js がロードされた直後、または SPA 遷移後に呼ぶ
  async function reapplyCurrentState() {
    try {
      const host = location.hostname;
      const data = await chrome.storage.local.get(host);
      const state = data[host];
      if (!state) return;
      currentVolume = state.volume;
      currentEffect = state.effect;
      currentIntensity = state.intensity ?? 100;
      sendToPage(state.volume, state.effect, currentIntensity);
    } catch (e) {
      console.debug('[SoundEnhance] reapplyCurrentState error:', e);
    }
  }

  // ── 【TikTok修正】SPA遷移（pushState/replaceState/popstate）を検知 ──
  // TikTok は History API でページ遷移する SPA のため、
  // URL が変わるたびに状態を再適用する。
  (function hookSPANavigation() {
    const _pushState    = history.pushState.bind(history);
    const _replaceState = history.replaceState.bind(history);

    function onNavigate() {
      // 少し待ってから再適用（新しいビデオのロードを待つ）
      setTimeout(() => {
        hookAllMedia();
        reapplyCurrentState();
      }, 800);
      setTimeout(() => {
        hookAllMedia();
        reapplyCurrentState();
      }, 2500);
    }

    history.pushState = function (...args) {
      _pushState(...args);
      onNavigate();
    };
    history.replaceState = function (...args) {
      _replaceState(...args);
      onNavigate();
    };
    window.addEventListener('popstate', onNavigate, { passive: true });
  })();

  // ── メッセージリスナー (popup -> content -> injected) ─
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // ステータス問い合わせ（popup UX 改善用）
    if (msg.type === 'SOUND_ENHANCE_STATUS') {
      sendResponse({ method: activeMethod });
      return true;
    }

    if (msg.type !== 'SOUND_ENHANCE') return;

    currentVolume = msg.volume;
    currentEffect = msg.effect;
    currentIntensity = msg.intensity ?? 100;

    // ── [new] tabcapture サイトは background.js に丸投げして終了
    if (isTabCapture()) {
      sendTabCaptureUpdate(msg.volume, msg.effect, currentIntensity);
      return;
    }

    // ── 【TikTok修正】acx-only でも必ず sendToPage する
    // 旧コードでは acx-only が connectElement で return してしまい
    // sendToPage が呼ばれなかった。メッセージ受信時は常に送る。
    sendToPage(msg.volume, msg.effect, currentIntensity);

    hookAllMedia();
    if (audioCtx && audioCtx.state === 'suspended') {
      safe(() => audioCtx.resume(), 'resume on msg');
    }

    // [perf] applyEffect は内部で「前回と同じエフェクト/強度なら何もしない」
    // 判定を持つため、毎回呼んでも重いリバーブ再生成等は走らない。
    // 音量だけが高速に変わるケース（スライダードラッグ等）でも安全。
    safe(() => applyEffect(msg.effect, currentIntensity), 'applyEffect msg');
    safe(() => applyVolume(msg.volume), 'applyVolume msg');
  });

  // ── ページロード時の状態復元 ─────────────────────────
  (async function restoreState() {
    try {
      const host = location.hostname;
      const data = await chrome.storage.local.get(host);
      const state = data[host];
      if (!state) return;

      currentVolume = state.volume;
      currentEffect = state.effect;
      currentIntensity = state.intensity ?? 100;

      // ── [new] tabcapture サイトはページ読み込み時に1回だけ送れば十分
      // （MES/ACXのようにDOM/AudioContextの出現を待つポーリングは不要）
      if (isTabCapture()) {
        activeMethod = 'TabCapture';
        sendTabCaptureUpdate(state.volume, state.effect, currentIntensity);
        return;
      }

      const apply = () => {
        // ── 【TikTok修正】acx-only でも必ず sendToPage する
        sendToPage(state.volume, state.effect, currentIntensity);
        hookAllMedia();
        const chains = getAllChains();
        if (chains.length > 0) {
          safe(() => applyEffect(state.effect, currentIntensity), 'restore effect');
          safe(() => applyVolume(state.volume), 'restore volume');
        }
      };

      // injected.js のロード完了を待つ余裕を持たせる
      setTimeout(apply, 500);
      setTimeout(apply, 2000);
      setTimeout(apply, 5000);
    } catch (e) {
      console.debug('[SoundEnhance] restoreState error:', e);
    }
  })();

})();
