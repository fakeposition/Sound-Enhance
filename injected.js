// injected.js — ACX (AudioContext) patch, ページの MAIN world で実行される
//
// 目的:
//   content.js は、拡張機能のコンテンツスクリプト world から <video>/<audio>
//   要素を createMediaElementSource() で横取りする「MES方式」を基本としているが、
//   以下のケースでは MES 方式が使えない、または無音化してしまう:
//     - SoundCloud等、CDNがCORSヘッダーを返さず、crossOrigin='anonymous' を
//       設定して createMediaElementSource に繋ぐと例外を出さずに音声が
//       tainted(無音)になる
//     - サイト自身が独自の AudioContext / Web Audio ノードグラフで再生を
//       完結させており、<audio>/<video> 要素の .volume を直接いじっても
//       実際の出力に反映されない
//
//   この injected.js は「ページ自身のコード」として実行されるため、CORSの
//   制約を受けずに、ページが構築する Web Audio グラフそのものにフックできる。
//   具体的には AudioNode.prototype.connect をパッチし、ページ側のノードが
//   ctx.destination に直接つながろうとした瞬間を検知して、代わりに自前の
//   処理チェーン（Bass/Treble/Mono/Panner/Reverb/Gain）を経由させてから
//   destination に流す。
//
// content.js とのやり取り:
//   - content.js -> ここ: window.dispatchEvent(new CustomEvent('__soundEnhanceApply', { detail: { volume, effect } }))
//   - ここ -> content.js: window.dispatchEvent(new CustomEvent('__soundEnhanceInjected'))  (準備完了通知、1回のみ)

(function () {
  'use strict';

  // 二重注入ガード（SPA遷移等で複数回 executeScript されても安全に）
  if (window.__soundEnhanceACXInstalled) return;
  window.__soundEnhanceACXInstalled = true;

  function safe(fn, label) {
    try { return fn(); }
    catch (e) { /* ページワールドなのでコンソールを汚さない程度に留める */ return undefined; }
  }

  let currentVolume = 100;
  let currentEffect = 'none';
  let currentIntensity = 100; // 100 = 1.00x (default/current behavior), 0–300 range

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // AudioContext ごとに1つの処理チェーンを保持
  const chainByCtx = new WeakMap();
  const allChains  = []; // 反復更新用（WeakMap は列挙できないため配列も保持）

  // ── インパルス応答（リバーブ用） ─────────────────────────
  function createImpulse(ctx, duration, decay, reverse) {
    return safe(() => {
      const rate   = ctx.sampleRate;
      const length = Math.max(1, Math.floor(rate * duration));
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
    }, 'createImpulse');
  }

  // ── チェーン構築 ──────────────────────────────────────
  // input: ページ側の音声ノードが最終的に繋ぎ込まれるエントリポイント
  // input -> bassFilter -> trebleFilter -> monoDown -> monoUp -> pannerNode
  //        -> dryGain ────────────────────┐
  //        -> (convolver) -> wetGain ─────┼─> outGain -> ctx.destination
  function buildChain(ctx, origConnect) {
    const input        = ctx.createGain();
    const bassFilter    = ctx.createBiquadFilter();
    bassFilter.type     = 'lowshelf';
    bassFilter.frequency.value = 200;
    bassFilter.gain.value = 0;

    const trebleFilter   = ctx.createBiquadFilter();
    trebleFilter.type    = 'highshelf';
    trebleFilter.frequency.value = 3000;
    trebleFilter.gain.value = 0;

    // mono ダウンミックス/アップミックス（チャンネル数の切替で on/off）
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
    outGain.gain.value = currentVolume / 100;

    origConnect.call(input, bassFilter);
    origConnect.call(bassFilter, trebleFilter);
    origConnect.call(trebleFilter, monoDown);
    origConnect.call(monoDown, monoUp);
    origConnect.call(monoUp, pannerNode);
    origConnect.call(pannerNode, dryGain);
    origConnect.call(dryGain, outGain);
    origConnect.call(wetGain, outGain);
    origConnect.call(outGain, ctx.destination); // ここは自前チェーンの出口なので直結してOK

    const chain = {
      ctx, input, bassFilter, trebleFilter, monoDown, monoUp,
      pannerNode, dryGain, wetGain, outGain,
      convolver: null, panInterval: null,
    };
    allChains.push(chain);
    return chain;
  }

  function getChain(ctx, origConnect) {
    let chain = chainByCtx.get(ctx);
    if (!chain) {
      chain = safe(() => buildChain(ctx, origConnect), 'buildChain');
      if (chain) {
        chainByCtx.set(ctx, chain);
        // [perf] 新規チェーンを現在のエフェクト/音量に同期する。
        // applyEffect() は「変化があった時」しか全チェーンへ再適用しない
        // ため、後から現れる AudioContext（新しいタブの動画等）はここで
        // 個別に初期化しておく必要がある。
        safe(() => applyEffectToChain(chain, currentEffect, currentIntensity), 'init chain effect');
        safe(() => applyVolumeToChain(chain, currentVolume, currentEffect), 'init chain volume');
      }
    }
    return chain;
  }

  // ── AudioNode.prototype.connect をパッチ ─────────────────
  // ページ側のノードが ctx.destination に直接つながろうとしたら、
  // 代わりに自前チェーンの input に接続する。
  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (destinationOrParam, ...args) {
    try {
      if (typeof AudioDestinationNode !== 'undefined' && destinationOrParam instanceof AudioDestinationNode) {
        const ctx = this.context;
        const chain = getChain(ctx, origConnect);
        // 自前チェーンの出口ノード自身が destination に繋ぐ処理はそのまま通す
        if (chain && this !== chain.outGain) {
          origConnect.call(this, chain.input, ...args);
          return destinationOrParam; // spec通り、接続先ノードを返す
        }
      }
    } catch (e) { /* 何かあれば素通しにフォールバック */ }
    return origConnect.apply(this, [destinationOrParam, ...args]);
  };

  // [perf] インパルス応答バッファのキャッシュ。content.js 側と同じ理由で、
  // duration/decay は強度(intensity)では変化しないため AudioContext ごとに
  // 一度だけ生成してキャッシュ・使い回す（以前は毎回再生成しており、強度
  // スライダーのドラッグ中にページが重くなる/クラッシュする主因だった）。
  const impulseCache = new WeakMap(); // ctx -> Map(key -> AudioBuffer)

  function getImpulse(ctx, duration, decay, reverse) {
    let map = impulseCache.get(ctx);
    if (!map) { map = new Map(); impulseCache.set(ctx, map); }
    const key = duration + '_' + decay + '_' + (reverse ? 1 : 0);
    if (map.has(key)) return map.get(key);
    const buf = createImpulse(ctx, duration, decay, reverse);
    map.set(key, buf);
    return buf;
  }

  // ── リバーブ設定 ──────────────────────────────────────
  function setupReverb(ctx, chain, duration, decay, wetLevel, trebleBoost, reverse) {
    safe(() => {
      // [perf] コンボルバーノードはチェーンごとに一度だけ作って使い回す。
      // 鳴らさない時は wetGain を 0 にするだけで無音になるので、ノード自体は
      // 繋ぎっぱなしのままでよい（disconnect/再接続の連発を避ける）。
      if (!chain.convolver) {
        const conv = ctx.createConvolver();
        origConnect.call(chain.pannerNode, conv);
        origConnect.call(conv, chain.wetGain);
        chain.convolver = conv;
        chain.convolverKey = null;
      }
      const key = duration + '_' + decay + '_' + (reverse ? 1 : 0);
      if (chain.convolverKey !== key) {
        const buf = getImpulse(ctx, duration, decay, reverse);
        if (buf) {
          chain.convolver.buffer = buf;
          chain.convolverKey = key;
        }
      }
      chain.wetGain.gain.setTargetAtTime(wetLevel, ctx.currentTime, 0.05);
      chain.trebleFilter.gain.value = trebleBoost;
    }, 'setupReverb');
  }

  // ── エフェクト適用（全チェーン共通） ───────────────────
  // [perf] 音量スライダーを素早く動かした時などに、エフェクト自体は
  // 変わっていないのにリバーブの再生成やパン用 setInterval の再起動を
  // 繰り返してページが重くなる/クラッシュする問題への対策。
  //   ・音量の comp（かさ増し係数）計算を getVolumeComp に分離
  //   ・チェーン単位のボリューム適用を applyVolumeToChain に分離
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

  function applyEffectToChain(chain, effect, intensity) {
    const ctx = chain.ctx;
    const mult = (intensity ?? 100) / 100; // 1.0 = デフォルト（従来通り）の強度

    // [perf] パン系エフェクトのままなら setInterval は張り直さない
    // （content.js と同じ理由。強度スライダーのドラッグ中に毎フレーム
    // clearInterval/setInterval していたのを解消）。
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
      chain.monoDown.channelCount = 2; // mono解除（パススルー）
      if (!PAN_EFFECTS[effect]) chain.pannerNode.pan.setTargetAtTime(0, ctx.currentTime, 0.02);
      chain.dryGain.gain.setTargetAtTime(1, ctx.currentTime, 0.02);
      chain.wetGain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      // [perf] convolver はここでは破棄しない。setupReverb() がノードを
      // 使い回し、wetGain=0 で無音化されるので十分。
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
        chain.dryGain.gain.setTargetAtTime(dry, ctx.currentTime, 0.05);
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
        chain.dryGain.gain.setTargetAtTime(dry, ctx.currentTime, 0.05);
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
        chain.dryGain.gain.setTargetAtTime(dry, ctx.currentTime, 0.05);
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
        chain.dryGain.gain.setTargetAtTime(dry, ctx.currentTime, 0.05);
        startPan('vacuum', 0.003, 70);
        break;
      }

      case 'mono':
        chain.monoDown.channelCount = 1; // L+R を平均してモノラル化 → monoUp で再度2ch展開
        break;
      // mono/none は連続パラメータを持たないため、強度の影響を受けない
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
    allChains.forEach(chain => applyEffectToChain(chain, effect, eff));
  }

  function applyVolumeToChain(chain, volumePct, effect) {
    const comp = getVolumeComp(effect);
    safe(() => chain.outGain.gain.setTargetAtTime((volumePct / 100) * comp, chain.ctx.currentTime, 0.02), 'applyVolume');
  }

  function applyVolume(volumePct) {
    currentVolume = volumePct;
    allChains.forEach(chain => applyVolumeToChain(chain, volumePct, currentEffect));
  }

  // ── content.js からの指示を受信 ───────────────────────
  window.addEventListener('__soundEnhanceApply', (e) => {
    const detail = e?.detail || {};
    if (typeof detail.intensity === 'number') currentIntensity = detail.intensity;
    if (typeof detail.effect === 'string') applyEffect(detail.effect, currentIntensity);
    if (typeof detail.volume === 'number')  applyVolume(detail.volume);
  }, { passive: true });

  // ── 準備完了を content.js に通知 ───────────────────────
  // 既に存在する AudioContext がある場合に備え、ページの既存 AudioContext
  // インスタンスは自動検知できない（connect パッチは今後の connect() 呼び出し
  // にのみ効くため）。多くのサイトは初回再生時に connect() を呼び直すか、
  // インタラクション後に AudioContext を resume/再構築するため実運用上は問題ないが、
  // 保険として少し遅延して通知する。
  window.dispatchEvent(new CustomEvent('__soundEnhanceInjected'));
})();
