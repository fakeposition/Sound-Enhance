// offscreen.js — chrome.tabCapture ベースの音声処理
//
// [new] Netflix / Spotify 対応
//   これらのサイトでは injected.js の AudioNode.connect パッチ（ACX方式）が
//   機能しない:
//     - Netflix: 多くの場合ページはWeb Audioグラフを自前で構築せず、
//       ブラウザが復号済み音声を <video> 要素へ直接流し込むだけのため、
//       パッチがフックする対象のグラフがそもそも存在しない。
//     - Spotify: 独自のWeb Audioグラフを構築するが、EME/DRM保護された
//       音声をWeb Audio経由で加工しようとするとブラウザ側の保護機構で
//       無音化/ブロックされることがある。
//   これらはページ内部の音声処理に依存しないため、
//   chrome.tabCapture でタブの最終音声出力そのものを MediaStream として
//   横取りし、ここ(オフスクリーンドキュメント)の別 AudioContext で
//   ゲイン/エフェクトをかけてから再生し直す。ページのDRM構造・実装に
//   一切依存しないのが利点（かわりにタブ音声を丸ごと専有するため、
//   対応が必要なサイトだけに限定して使う）。
//
// DSPチェーンの構成・パラメータは injected.js / content.js の
// buildChain / applyEffectToChain と揃えてある
// （bass/treble -> mono -> pan -> dry/wet(reverb) -> gain -> destination）。

(function () {
  'use strict';

  function safe(fn, label) {
    try { return fn(); }
    catch (e) { console.debug('[SoundEnhance offscreen]', label, e); return undefined; }
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  const chainsByTab = new Map(); // tabId -> chain

  // ── インパルス応答（リバーブ用） ─────────────────────────
  function createImpulse(ctx, duration, decay, reverse) {
    return safe(() => {
      const rate = ctx.sampleRate;
      const length = Math.max(1, Math.floor(rate * duration));
      const impulse = ctx.createBuffer(2, length, rate);
      for (let c = 0; c < 2; c++) {
        const ch = impulse.getChannelData(c);
        for (let i = 0; i < length; i++) {
          const n = reverse ? length - i : i;
          const env = Math.pow(1 - n / length, decay);
          ch[i] = (Math.random() * 2 - 1) * env * 0.5
                + (Math.random() * 2 - 1) * env * 0.3
                + (Math.random() * 2 - 1) * env * 0.2;
        }
      }
      return impulse;
    }, 'createImpulse');
  }

  const impulseCache = new WeakMap();
  function getImpulse(ctx, duration, decay, reverse) {
    let map = impulseCache.get(ctx);
    if (!map) { map = new Map(); impulseCache.set(ctx, map); }
    const key = duration + '_' + decay + '_' + (reverse ? 1 : 0);
    if (map.has(key)) return map.get(key);
    const buf = createImpulse(ctx, duration, decay, reverse);
    map.set(key, buf);
    return buf;
  }

  function setupReverb(ctx, chain, duration, decay, wetLevel, trebleBoost, reverse) {
    safe(() => {
      if (!chain.convolver) {
        const conv = ctx.createConvolver();
        chain.pannerNode.connect(conv);
        conv.connect(chain.wetGain);
        chain.convolver = conv;
        chain.convolverKey = null;
      }
      const key = duration + '_' + decay + '_' + (reverse ? 1 : 0);
      if (chain.convolverKey !== key) {
        const buf = getImpulse(ctx, duration, decay, reverse);
        if (buf) { chain.convolver.buffer = buf; chain.convolverKey = key; }
      }
      chain.wetGain.gain.setTargetAtTime(wetLevel, ctx.currentTime, 0.05);
      chain.trebleFilter.gain.value = trebleBoost;
    }, 'setupReverb');
  }

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

  const PAN_EFFECTS = { '3d': 1, '8d': 1, '16d': 1, 'water': 1, 'outdoor': 1, 'vacuum': 1 };

  function applyEffectToChain(chain, effect, intensity) {
    const ctx = chain.ctx;
    const mult = (intensity ?? 100) / 100;

    if (!PAN_EFFECTS[effect] && chain.panInterval) {
      clearInterval(chain.panInterval);
      chain.panInterval = null;
      chain.panKey = null;
    }

    safe(() => {
      chain.bassFilter.gain.value = 0;
      chain.trebleFilter.gain.value = 0;
      chain.bassFilter.frequency.value = 200;
      chain.trebleFilter.frequency.value = 3000;
      chain.monoDown.channelCount = 2;
      if (!PAN_EFFECTS[effect]) chain.pannerNode.pan.setTargetAtTime(0, ctx.currentTime, 0.02);
      chain.dryGain.gain.setTargetAtTime(1, ctx.currentTime, 0.02);
      chain.wetGain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    }, 'reset chain');

    function startPan(key, speed, intervalMs) {
      if (chain.panKey === key) return;
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
        chain.dryGain.gain.setTargetAtTime(dry, ctx.currentTime, 0.05);
        startPan('3d', 0.022, 30);
        break;
      }
      case '8d': {
        const wet = clamp(0.22 * mult, 0, 0.9);
        const treble = clamp(1.5 * mult, -24, 24);
        const dry = clamp(1 - 0.15 * (mult - 1), 0.3, 1);
        chain.panAmp = clamp(0.95 * mult, 0, 1);
        setupReverb(ctx, chain, 1.8, 3.5, wet, treble, false);
        chain.dryGain.gain.setTargetAtTime(dry, ctx.currentTime, 0.05);
        startPan('8d', 0.048, 30);
        break;
      }
      case '16d': {
        const wet = clamp(0.25 * mult, 0, 0.9);
        const treble = clamp(2 * mult, -24, 24);
        const dry = clamp(1 - 0.18 * (mult - 1), 0.3, 1);
        chain.panAmp = clamp(0.95 * mult, 0, 1);
        setupReverb(ctx, chain, 2.0, 3, wet, treble, false);
        chain.dryGain.gain.setTargetAtTime(dry, ctx.currentTime, 0.05);
        startPan('16d', 0.1, 30);
        break;
      }
      case 'live': {
        const wet = clamp(0.55 * mult, 0, 0.9);
        const treble = clamp(6 * mult, -24, 24);
        const bass = clamp(3 * mult, -24, 24);
        const dry = clamp(1 - 0.16 * (mult - 1), 0.2, 1);
        setupReverb(ctx, chain, 2.8, 2.0, wet, treble, false);
        chain.dryGain.gain.setTargetAtTime(dry, ctx.currentTime, 0.05);
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
        chain.bassFilter.gain.value = clamp(-8 * mult, -24, 24);
        chain.trebleFilter.gain.value = clamp(7 * mult, -24, 24);
        break;
      case 'loud':
        chain.bassFilter.gain.value = clamp(2 * mult, -24, 24);
        chain.trebleFilter.gain.value = clamp(1 * mult, -24, 24);
        break;
      case 'reverb': {
        const wet = clamp(0.38 * mult, 0, 0.9);
        const dry = clamp(1 - 0.24 * (mult - 1), 0.2, 1);
        setupReverb(ctx, chain, 3.0, 2.5, wet, 0, false);
        chain.dryGain.gain.setTargetAtTime(dry, ctx.currentTime, 0.05);
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
        chain.dryGain.gain.setTargetAtTime(dry, ctx.currentTime, 0.05);
        startPan('water', 0.008, 30);
        break;
      }
      case 'outdoor': {
        const bass = clamp(-7 * mult, -24, 24);
        const treble = clamp(-6 * mult, -24, 24);
        const wet = clamp(0.2 * mult, 0, 0.9);
        const dry = clamp(1 - 0.14 * (mult - 1), 0.4, 1);
        chain.panAmp = clamp(0.34 * mult, 0, 1);
        chain.bassFilter.gain.value = bass;
        chain.trebleFilter.gain.value = treble;
        setupReverb(ctx, chain, 0.9, 5, wet, -7, false);
        chain.dryGain.gain.setTargetAtTime(dry, ctx.currentTime, 0.05);
        startPan('outdoor', 0.007, 55);
        break;
      }
      case 'stadium': {
        const bass = clamp(5 * mult, -24, 24);
        const treble = clamp(-2 * mult, -24, 24);
        const wet = clamp(0.5 * mult, 0, 0.9);
        const dry = clamp(1 - 0.34 * (mult - 1), 0.15, 1);
        chain.bassFilter.gain.value = bass;
        chain.trebleFilter.gain.value = treble;
        setupReverb(ctx, chain, 3.5, 1.5, wet, -2, false);
        chain.dryGain.gain.setTargetAtTime(dry, ctx.currentTime, 0.05);
        break;
      }
      case 'call':
        chain.bassFilter.frequency.value = 350;
        chain.trebleFilter.frequency.value = 2200;
        chain.bassFilter.gain.value = clamp(-20 * mult, -24, 24);
        chain.trebleFilter.gain.value = clamp(6 * mult, -24, 24);
        break;
      case 'lofi': {
        chain.trebleFilter.frequency.value = 2200;
        const treble = clamp(-16 * mult, -24, 24);
        const bass = clamp(6 * mult, -24, 24);
        const wet = clamp(0.2 * mult, 0, 0.9);
        const dry = clamp(1 - 0.2 * (mult - 1), 0.3, 1);
        chain.trebleFilter.gain.value = treble;
        chain.bassFilter.gain.value = bass;
        setupReverb(ctx, chain, 0.8, 4.5, wet, -8, false);
        chain.dryGain.gain.setTargetAtTime(dry, ctx.currentTime, 0.05);
        break;
      }
      case 'vacuum': {
        const bass = clamp(4 * mult, -24, 24);
        const treble = clamp(-9 * mult, -24, 24);
        const wet = clamp(0.5 * mult, 0, 0.9);
        const dry = clamp(1 - 0.4 * (mult - 1), 0.15, 1);
        chain.panAmp = clamp(0.18 * mult, 0, 1);
        chain.bassFilter.gain.value = bass;
        chain.trebleFilter.gain.value = treble;
        setupReverb(ctx, chain, 6.0, 1.1, wet, -10, false);
        chain.dryGain.gain.setTargetAtTime(dry, ctx.currentTime, 0.05);
        startPan('vacuum', 0.003, 70);
        break;
      }
      case 'mono':
        chain.monoDown.channelCount = 1;
        break;
      case 'none':
      default:
        break;
    }
  }

  function applyVolumeToChain(chain, volumePct, effect) {
    const comp = getVolumeComp(effect);
    safe(() => chain.outGain.gain.setTargetAtTime((volumePct / 100) * comp, chain.ctx.currentTime, 0.02), 'applyVolume');
  }

  // ── タブ音声キャプチャの開始 ───────────────────────────
  async function startCapture(tabId, streamId, volume, effect, intensity) {
    stopCapture(tabId); // 念のため既存があれば破棄してから作り直す

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });

    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);

    const bassFilter = ctx.createBiquadFilter();
    bassFilter.type = 'lowshelf';
    bassFilter.frequency.value = 200;
    bassFilter.gain.value = 0;

    const trebleFilter = ctx.createBiquadFilter();
    trebleFilter.type = 'highshelf';
    trebleFilter.frequency.value = 3000;
    trebleFilter.gain.value = 0;

    const monoDown = ctx.createGain();
    monoDown.channelCount = 2;
    monoDown.channelCountMode = 'explicit';
    monoDown.channelInterpretation = 'speakers';
    const monoUp = ctx.createGain();
    monoUp.channelCount = 2;
    monoUp.channelCountMode = 'explicit';
    monoUp.channelInterpretation = 'speakers';

    const pannerNode = ctx.createStereoPanner();
    pannerNode.pan.value = 0;

    const dryGain = ctx.createGain();
    dryGain.gain.value = 1;
    const wetGain = ctx.createGain();
    wetGain.gain.value = 0;
    const outGain = ctx.createGain();
    outGain.gain.value = volume / 100;

    source.connect(bassFilter);
    bassFilter.connect(trebleFilter);
    trebleFilter.connect(monoDown);
    monoDown.connect(monoUp);
    monoUp.connect(pannerNode);
    pannerNode.connect(dryGain);
    dryGain.connect(outGain);
    wetGain.connect(outGain);
    outGain.connect(ctx.destination); // オフスクリーンドキュメント自身の出力として再生される

    const chain = {
      ctx, stream, source, bassFilter, trebleFilter, monoDown, monoUp,
      pannerNode, dryGain, wetGain, outGain,
      convolver: null, panInterval: null,
    };
    chainsByTab.set(tabId, chain);

    applyEffectToChain(chain, effect, intensity);
    applyVolumeToChain(chain, volume, effect);
  }

  function applyToCapture(tabId, volume, effect, intensity) {
    const chain = chainsByTab.get(tabId);
    if (!chain) return; // START が未完了/失敗 — 何もしない（次の更新で再試行される）
    applyEffectToChain(chain, effect, intensity);
    applyVolumeToChain(chain, volume, effect);
  }

  function stopCapture(tabId) {
    const chain = chainsByTab.get(tabId);
    if (!chain) return;
    chainsByTab.delete(tabId);
    safe(() => { if (chain.panInterval) clearInterval(chain.panInterval); }, 'clear panInterval');
    safe(() => chain.stream.getTracks().forEach(t => t.stop()), 'stop tracks');
    safe(() => chain.ctx.close(), 'close ctx');
  }

  // ── background.js からのメッセージ ────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.target !== 'offscreen') return;

    if (msg.type === 'SOUND_ENHANCE_TABCAPTURE_START') {
      startCapture(msg.tabId, msg.streamId, msg.volume, msg.effect, msg.intensity ?? 100)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => {
          console.debug('[SoundEnhance offscreen] startCapture failed:', e);
          sendResponse({ ok: false, error: String(e) });
        });
      return true; // async response
    }

    if (msg.type === 'SOUND_ENHANCE_TABCAPTURE_APPLY') {
      applyToCapture(msg.tabId, msg.volume, msg.effect, msg.intensity ?? 100);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'SOUND_ENHANCE_TABCAPTURE_STOP') {
      stopCapture(msg.tabId);
      sendResponse({ ok: true });
      return false;
    }
  });
})();
