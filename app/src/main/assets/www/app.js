/* Gibbon — personal pocket sampler.
 * Original work: record → pads → sequence → mix FX → resample → WAV.
 * Runs offline in an Android WebView (see GibbonBridge) or any modern browser. */
'use strict';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const NUM_BANKS = 4, PADS_PER_BANK = 16, NUM_PADS = NUM_BANKS * PADS_PER_BANK;
const NUM_PATTERNS = 8;       // "sequences", MPC-style
const PPQ = 96;               // ticks per quarter note (MPC resolution)
const STEP_T = PPQ / 4;       // one 16th = 24 ticks (grid view unit)
/* timing correct: note value → grid size in ticks (null = OFF, record exact) */
const TC = { '16': 24, '8': 48, '8T': 32, '16T': 16, '32': 12, '32T': 8, 'OFF': null };
const TC_ORDER = ['16', '8', '8T', '16T', '32', '32T', 'OFF'];
const SCALES = { chrom: [0,1,2,3,4,5,6,7,8,9,10,11], major: [0,2,4,5,7,9,11], minor: [0,2,3,5,7,8,10], pmin: [0,3,5,7,10], pmaj: [0,2,4,7,9] };
const VERSION = 'v4.2';

/* ------------------------------------------------ state */
const S = {
  bpm: 120, swing: 50, tc: '16', playing: false, metro: false,
  bank: 0, selPad: 0, pattern: 0,
  keys: false, scale: 'pmin',
  recArm: false, recordingPad: -1, noteRec: false,
  fullLevel: true, noteRepeat: false, sixteen: null /* null|'vel'|'tune' */, levelsPad: 0, erase: false,
  fx: null, fxLatch: false, fxXY: { x: .5, y: .5 },
  chain: [],    // [{seq, reps}]
  patterns: [], // sequences: [{bars, events:[{t, pad, vel}]}]
  pads: [],
  solo: new Set(),
  clipboard: null,
  projName: 'untitled',
};
for (let i = 0; i < NUM_PATTERNS; i++) S.patterns.push(newSeq());
for (let i = 0; i < NUM_PADS; i++) S.pads.push(newPad());
function newSeq() { return { bars: 2, events: [] }; }
function seqTicks(p) { return p.bars * 4 * PPQ; }
function newPad() {
  return { buf: null, name: '', gain: 1, pan: 0, semis: 0, fine: 0, mode: 'oneshot', choke: 0,
           start: 0, end: 1, attack: 0, release: 0, cutoff: 20000, res: 0, mono: false, velFilt: false, mute: false };
}
/* swing: MPC-style 50–75%, shifts the offbeat of the TC pair; only for 8/16 grids */
function swingDelayTicks(t) {
  if (S.swing <= 50) return 0;
  const g = TC[S.tc];
  if (g !== 24 && g !== 48) return 0;
  const pair = g * 2;
  return (t % pair === g) ? Math.round(pair * (S.swing - 50) / 100) : 0;
}

/* ------------------------------------------------ audio graph */
let ctx = null, master = {}, micStream = null, recNode = null;
let recChunks = [], recLen = 0, recTarget = -1, recTimer = 0, recKind = 'mic';
const activeSrc = new Map(); // padIdx -> [{src,g}]

const WORKLET_SRC = `
class Cap extends AudioWorkletProcessor {
  constructor(){ super(); this.on=false; this.port.onmessage=e=>{ this.on = e.data==='start'; }; }
  process(inputs){
    if (this.on && inputs[0] && inputs[0][0]) {
      const L = inputs[0][0], R = inputs[0][1] || inputs[0][0];
      this.port.postMessage({ L: L.slice(0), R: R.slice(0) });
    }
    return true;
  }
}
registerProcessor('cap', Cap);
class Crush extends AudioWorkletProcessor {
  constructor(){ super(); this.bits=16; this.down=1; this.wet=0; this.hold=[0,0]; this.n=0;
    this.port.onmessage=e=>{ Object.assign(this, e.data); }; }
  process(inputs, outputs){
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) return true;
    const step = Math.pow(2, this.bits - 1);
    for (let c = 0; c < out.length; c++) {
      const i = inp[c] || inp[0], o = out[c];
      for (let s = 0; s < o.length; s++) {
        if ((this.n + s) % this.down === 0) this.hold[c] = Math.round(i[s] * step) / step;
        o[s] = i[s] * (1 - this.wet) + this.hold[c] * this.wet;
      }
    }
    this.n += out[0].length;
    return true;
  }
}
registerProcessor('crush', Crush);
class Clock extends AudioWorkletProcessor {
  constructor(){ super(); this.n = 0; }
  process(){
    this.n += 128;
    if (this.n >= 1024) { this.n = 0; this.port.postMessage(0); } // ~23ms pump, immune to timer throttling
    return true;
  }
}
registerProcessor('clock', Clock);`;

let audioInit = null;
async function ensureAudio() {
  if (audioInit) {                       // never return before the graph is fully built
    await audioInit;
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    return;
  }
  audioInit = buildAudio();
  await audioInit;
}
async function buildAudio() {
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  // iOS: contexts can be born suspended, and calls/route changes suspend them later
  if (ctx.state !== 'running') await ctx.resume().catch(() => {});
  ctx.onstatechange = () => {
    if (ctx.state === 'suspended' && document.visibilityState === 'visible') ctx.resume().catch(() => {});
  };
  const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);

  const m = master;
  m.in = ctx.createGain();
  m.hp = ctx.createBiquadFilter(); m.hp.type = 'highpass'; m.hp.frequency.value = 10; m.hp.Q.value = .7;
  m.lp = ctx.createBiquadFilter(); m.lp.type = 'lowpass'; m.lp.frequency.value = 20000; m.lp.Q.value = .7;
  m.crush = new AudioWorkletNode(ctx, 'crush', { outputChannelCount: [2] });
  m.gate = ctx.createGain();
  m.comp = ctx.createDynamicsCompressor();
  m.comp.threshold.value = -12; m.comp.ratio.value = 4; m.comp.attack.value = .003; m.comp.release.value = .12;
  m.out = ctx.createGain();
  m.in.connect(m.hp); m.hp.connect(m.lp); m.lp.connect(m.crush); m.crush.connect(m.gate); m.gate.connect(m.comp); m.comp.connect(m.out); m.out.connect(ctx.destination);

  // delay send (feedback loop with tone filter)
  m.dSend = ctx.createGain(); m.dSend.gain.value = 0;
  m.delay = ctx.createDelay(2); m.delay.delayTime.value = .3;
  m.dFb = ctx.createGain(); m.dFb.gain.value = .35;
  m.dTone = ctx.createBiquadFilter(); m.dTone.type = 'lowpass'; m.dTone.frequency.value = 4000;
  m.in.connect(m.dSend); m.dSend.connect(m.delay); m.delay.connect(m.dTone); m.dTone.connect(m.dFb); m.dFb.connect(m.delay); m.dTone.connect(m.gate);

  // reverb send
  m.rSend = ctx.createGain(); m.rSend.gain.value = 0;
  m.verb = ctx.createConvolver(); m.verb.buffer = makeIR(ctx, 2.2);
  m.in.connect(m.rSend); m.rSend.connect(m.verb); m.verb.connect(m.gate);

  // capture tap (for resample + bounce)
  m.cap = new AudioWorkletNode(ctx, 'cap', { numberOfInputs: 1, channelCount: 2 });
  m.comp.connect(m.cap);
  m.cap.port.onmessage = e => onCapChunk(e.data);

  // audio-thread clock: keeps the sequencer scheduled even when the page's
  // timers are throttled (screen dimmed / app backgrounded while playing)
  m.clock = new AudioWorkletNode(ctx, 'clock', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
  const mute0 = ctx.createGain(); mute0.gain.value = 0;
  m.clock.connect(mute0); mute0.connect(ctx.destination); // keep it pulled in the graph
  m.clock.port.onmessage = () => { if (S.playing) schedule(); };
}

function makeIR(c, seconds) {
  const sr = c.sampleRate, len = Math.floor(sr * seconds);
  const buf = c.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
  }
  return buf;
}

/* ------------------------------------------------ pad playback */
function gridDegree(gridPos) { return (3 - (gridPos >> 2)) * 4 + (gridPos & 3); } // bottom-left = 0
/* semitone offset a grid position adds in the current mode (0 outside keys/16-tune) */
function gridSemiOff(gridPos) {
  if (gridPos === undefined) return 0;
  if (S.sixteen === 'tune') return gridDegree(gridPos) - 12; // pads 1-16 → -12..+3 st
  if (!S.keys) return 0;
  const sc = SCALES[S.scale], deg = gridDegree(gridPos);
  return sc[deg % sc.length] + 12 * Math.floor(deg / sc.length);
}

/* semiOff = semitone offset baked at record/tap time (keys / 16-levels-tune),
 * so recorded melodies survive mode toggles, reloads and offline export */
function triggerPad(idx, when = 0, semiOff = 0, dest = null, oCtx = null, vel = 127) {
  const c = oCtx || ctx, p = S.pads[idx];
  if (!c || !p.buf) return null;
  if (p.mute || (S.solo.size && !S.solo.has(idx))) return null;
  const t0 = when || c.currentTime;
  if (!oCtx) {
    if (p.choke) for (let i = 0; i < NUM_PADS; i++) {
      if (S.pads[i].choke === p.choke) stopPad(i, t0);
    }
    else if (p.mono) stopPad(idx, t0);
  }
  const src = c.createBufferSource();
  src.buffer = p.buf;
  src.playbackRate.value = Math.pow(2, (p.semis + (semiOff || 0) + p.fine / 100) / 12);
  if (p.mode === 'loop') { src.loop = true; src.loopStart = p.start * p.buf.duration; src.loopEnd = p.end * p.buf.duration; }

  const v = clamp(vel, 1, 127) / 127;
  const level = p.gain * Math.pow(v, 1.3);
  const g = c.createGain();
  let head = src;
  const wantFilter = p.cutoff < 19000 || p.res > .5 || (p.velFilt && v < 1);
  if (wantFilter) {
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    const cut = p.velFilt ? p.cutoff * (.25 + .75 * v) : p.cutoff;
    f.frequency.value = clamp(cut, 100, 20000);
    f.Q.value = p.res;
    head.connect(f); head = f;
  }
  head.connect(g);
  const pan = c.createStereoPanner ? c.createStereoPanner() : null;
  if (pan) { pan.pan.value = p.pan; g.connect(pan); pan.connect(dest || master.in); }
  else g.connect(dest || master.in);

  const dur = (p.end - p.start) * p.buf.duration / src.playbackRate.value;
  // amp envelope: attack ramp in, optional release fade at the sample tail (one-shot)
  if (p.attack > 0) {
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(level, t0 + p.attack / 1000);
  } else g.gain.setValueAtTime(level, t0);
  if (p.mode === 'oneshot' && p.release > 0) {
    const relS = Math.min(p.release / 1000, dur * .9);
    g.gain.setValueAtTime(level, t0 + dur - relS);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
  }

  const off = p.start * p.buf.duration;
  if (p.mode === 'loop') src.start(t0, off);
  else src.start(t0, off, dur * src.playbackRate.value); // 3rd arg is buffer-domain seconds
  if (!oCtx) {
    if (!activeSrc.has(idx)) activeSrc.set(idx, []);
    const rec = { src, g };
    activeSrc.get(idx).push(rec);
    src.onended = () => { const a = activeSrc.get(idx); if (a) { const k = a.indexOf(rec); if (k >= 0) a.splice(k, 1); } };
  }
  return src;
}

function stopPad(idx, when) {
  const a = activeSrc.get(idx);
  if (!a) return;
  const p = S.pads[idx];
  const t = when || (ctx ? ctx.currentTime : 0);
  const rel = Math.max(.01, (p.release || 0) / 1000);
  for (const r of a) {
    try {
      r.g.gain.cancelScheduledValues(t);
      r.g.gain.setTargetAtTime(0, t, rel / 3);
      r.src.stop(t + rel + .05);
    } catch (e) {}
  }
  activeSrc.set(idx, []);
}
function stopAllPads() { for (let i = 0; i < NUM_PADS; i++) stopPad(i); }

/* ------------------------------------------------ sequencer (tick engine, 96 PPQ) */
let nextTickTime = 0, curTick = 0, schedTimer = 0, songQueue = [], songPos = 0;
const LOOKAHEAD = 0.12, TICK = 25;
const heldPads = new Map(); // keyed by grid element (finger) -> {idx, vel, off}; multi-touch safe
const heldIdx = pad => { for (const h of heldPads.values()) if (h.idx === pad) return true; return false; };

function stepDur() { return 60 / S.bpm / 4; }
function tickDur() { return 60 / S.bpm / PPQ; }

/* events indexed by tick for O(1) scheduling; invalidated on every edit */
function byTick(pat) {
  if (!pat._byTick) {
    pat._byTick = new Map();
    for (const ev of pat.events) {
      if (!pat._byTick.has(ev.t)) pat._byTick.set(ev.t, []);
      pat._byTick.get(ev.t).push(ev);
    }
  }
  return pat._byTick;
}
function touchSeq(pat) { pat._byTick = null; }

function schedule() {
  let pat = S.patterns[S.pattern];
  let total = seqTicks(pat);
  while (nextTickTime < ctx.currentTime + LOOKAHEAD) {
    const t = nextTickTime;
    if (curTick < 0) {
      // count-in bar: metronome only
      if (curTick % PPQ === 0) click(t, curTick === -4 * PPQ);
    } else {
      const evs = byTick(pat).get(curTick);
      if (evs) for (const ev of evs) {
        if (ev.skip) { const s = ev.skip; ev.skip = 0; if (t < s) continue; } // live hit already heard
        if (S.erase && heldIdx(ev.pad)) continue; // realtime erase: skip + remove below
        triggerPad(ev.pad, t + swingDelayTicks(ev.t) * tickDur(), ev.o, null, null, ev.vel);
      }
      if (S.erase && heldPads.size) {
        const before = pat.events.length;
        pat.events = pat.events.filter(ev => !(ev.t === curTick && heldIdx(ev.pad)));
        if (pat.events.length !== before) { touchSeq(pat); dirty(); }
      }
      // note repeat: retrigger held pads on the TC grid (with swing)
      const g = TC[S.tc];
      if (S.noteRepeat && !S.erase && g && heldPads.size && curTick % g === 0) {
        for (const h of heldPads.values()) {
          const when = t + swingDelayTicks(curTick) * tickDur();
          triggerPad(h.idx, when, h.off, null, null, h.vel);
          if (S.noteRec) insertEvent(pat, curTick, h.idx, h.vel, h.off);
        }
      }
      if (S.metro && curTick % PPQ === 0) click(t, curTick % (4 * PPQ) === 0);
      if (S.fx === 'gate' && gateParams.depth > 0) {
        const div = gateParams.div * STEP_T;
        if (curTick % div === 0) {
          const gg = master.gate.gain;
          gg.setValueAtTime(1, t);
          gg.setTargetAtTime(1 - gateParams.depth, t + div * tickDur() * .5, .004);
        }
      }
      if (curTick % STEP_T === 0) uiStep(curTick / STEP_T);
    }
    curTick++;
    if (curTick >= total) {
      curTick = 0;
      if (S.playing === 'song' && songQueue.length) {
        songPos = (songPos + 1) % songQueue.length;
        S.pattern = songQueue[songPos];
        pat = S.patterns[S.pattern]; total = seqTicks(pat); // refresh — no seam from the old sequence
        touchSeq(pat);
        drawSeqTop(); drawSteps();
      }
    }
    nextTickTime += tickDur();
  }
}

function insertEvent(pat, t, pad, vel, off) {
  let ev = pat.events.find(e => e.t === t && e.pad === pad && (e.o || 0) === (off || 0));
  if (ev) { ev.vel = Math.max(ev.vel, vel); }
  else {
    ev = { t, pad, vel };
    if (off) ev.o = off;
    pat.events.push(ev);
  }
  touchSeq(pat); dirty();
  drawRowChips(); drawSteps();
  return ev;
}

function click(t, accent) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = accent ? 1568 : 1046;
  g.gain.setValueAtTime(.25, t); g.gain.exponentialRampToValueAtTime(.001, t + .04);
  o.connect(g); g.connect(master.out); o.start(t); o.stop(t + .05);
}

function expandChain() {
  const q = [];
  for (const step of S.chain) for (let r = 0; r < (step.reps || 1); r++) q.push(step.seq);
  return q;
}
async function play(song = false) {
  await ensureAudio();
  S.playing = song ? 'song' : true;
  if (song && S.chain.length) { songQueue = expandChain(); songPos = 0; S.pattern = songQueue[0]; }
  touchSeq(S.patterns[S.pattern]);
  curTick = S.noteRec && !song ? -4 * PPQ : 0; // one-bar count-in when recording
  nextTickTime = ctx.currentTime + .06;
  schedTimer = setInterval(schedule, TICK);
  $('#btnPlay').classList.add('on'); $('#btnPlay').textContent = '■';
  keepAwake(true);
}
function stop() {
  S.playing = false;
  clearInterval(schedTimer);
  heldPads.clear();
  stopAllPads();
  if (master.gate) master.gate.gain.cancelScheduledValues(0), master.gate.gain.value = 1;
  $('#btnPlay').classList.remove('on'); $('#btnPlay').textContent = '▶';
  $$('.step.cur').forEach(el => el.classList.remove('cur'));
  if (recTarget === -1) keepAwake(false);
}

function liveTickNow() {
  return curTick - (nextTickTime - ctx.currentTime) / tickDur();
}
function liveRecordNote(idx, vel, off) {
  if (!S.playing || !S.noteRec) return;
  const pat = S.patterns[S.pattern], total = seqTicks(pat);
  let tick = liveTickNow();
  const g = TC[S.tc];
  if (g) {
    // quantize against the SWUNG grid: snap to the gridpoint whose heard
    // (swing-delayed) position is nearest — playback re-applies the delay
    const a = Math.floor(tick / g) * g, b = a + g;
    tick = (tick - a - swingDelayTicks(((a % total) + total) % total)) < (b + swingDelayTicks(((b % total) + total) % total) - tick) ? a : b;
  } else tick = Math.round(tick);
  if (tick < 0) return; // still in the count-in (early downbeats quantize to 0 first)
  const ahead = tick >= curTick; // quantized forward past the scheduler pointer
  tick = ((tick % total) + total) % total;
  const ev = insertEvent(pat, tick, idx, vel, off);
  // the live hit already sounded — don't let the scheduler re-fire it this pass
  if (ahead) ev.skip = ctx.currentTime + LOOKAHEAD + .05;
}

/* ------------------------------------------------ mic recording + resample */
let micSrc = null;
async function ensureMic() {
  if (micStream) return;
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  micSrc = ctx.createMediaStreamSource(micStream);
  recNode = new AudioWorkletNode(ctx, 'cap', { numberOfInputs: 1 });
  micSrc.connect(recNode);
  recNode.port.onmessage = e => onCapChunk(e.data, 'mic');
}
/* release the mic between recordings — while it is held, iOS runs a degraded
 * play-and-record session (ducked, receiver-quality output) and a backgrounded
 * tab can kill the track for good. ensureMic() reacquires on the next record. */
function releaseMic() {
  if (!micStream) return;
  try { micStream.getTracks().forEach(t => t.stop()); } catch (e) {}
  try { if (micSrc) micSrc.disconnect(); } catch (e) {}
  try { if (recNode) recNode.disconnect(); } catch (e) {}
  micStream = null; micSrc = null; recNode = null;
}

function onCapChunk(d, from) {
  if (recTarget === -1) return;
  if (recKind !== (from || 'master')) return;
  recChunks.push(d); recLen += d.L.length;
  let peak = 0; for (let i = 0; i < d.L.length; i += 8) peak = Math.max(peak, Math.abs(d.L[i]));
  $('#meter').style.width = Math.min(100, peak * 130) + '%';
  // safety caps: 40s for a pad, 6 min for a field recording in the chop lab
  if (recLen > ctx.sampleRate * (recTarget === CHOP_TARGET ? 360 : 40)) stopRecording();
}

async function startMicRecording(padIdx) {
  await ensureAudio();
  try { await ensureMic(); } catch (e) { toast('Microphone unavailable: ' + e.message); S.recArm = false; drawTopbar(); return; }
  recKind = 'mic'; recChunks = []; recLen = 0; recTarget = padIdx;
  recNode.port.postMessage('start');
  keepAwake(true);
  S.recordingPad = padIdx; drawPads(); drawTopbar();
  toast('Recording pad ' + padLabel(padIdx) + ' — tap again to stop');
}

function startResample() {
  recKind = 'master'; recChunks = []; recLen = 0;
  let padIdx = S.pads.findIndex(p => !p.buf);
  if (padIdx < 0) { toast('No empty pad'); return; }
  recTarget = padIdx;
  master.cap.port.postMessage('start');
  $('#resampleBar').classList.add('on');
  toast('Resampling into pad ' + padLabel(padIdx));
}

function stopRecording() {
  if (recTarget === -1) return;
  const padIdx = recTarget; recTarget = -1;
  if (recKind === 'mic') { recNode.port.postMessage('stop'); releaseMic(); }
  else { master.cap.port.postMessage('stop'); $('#resampleBar').classList.remove('on'); }
  $('#meter').style.width = '0';
  if (!S.playing) keepAwake(false);
  if (padIdx === CHOP_TARGET) { finalizeChopRecording(); return; }
  if (recLen < 256) { toast('Too short'); S.recordingPad = -1; drawPads(); return; }
  const buf = ctx.createBuffer(2, recLen, ctx.sampleRate);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  let o = 0;
  for (const c of recChunks) { L.set(c.L, o); R.set(c.R, o); o += c.L.length; }
  recChunks = [];
  const p = S.pads[padIdx];
  p.buf = buf; p.start = 0; p.end = 1;
  p.name = (recKind === 'mic' ? 'mic ' : 'rsmp ') + new Date().toTimeString().slice(0, 8);
  S.recordingPad = -1; S.recArm = false; S.selPad = padIdx;
  drawTopbar(); drawPads(); drawEdit(); dirty();
  toast('Sampled → pad ' + padLabel(padIdx));
}

/* ------------------------------------------------ import */
let importDest = 'pad';
$('#fileIn').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  const dest = importDest; importDest = 'pad';
  if (!f) return;
  await ensureAudio();
  try {
    const ab = await f.arrayBuffer();
    const buf = await ctx.decodeAudioData(ab);
    if (dest === 'chop') {
      const mono = ctx.createBuffer(1, buf.length, buf.sampleRate);
      const L = mono.getChannelData(0), a = buf.getChannelData(0);
      const b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
      for (let i = 0; i < buf.length; i++) L[i] = (a[i] + b[i]) / 2;
      C.buf = mono; C.sr = buf.sampleRate; C.markers = []; C.z = 1; C.off = 0;
      drawChop(); dirty(); saveChopSource();
      toast('Loaded ' + fmtTime(buf.duration) + ' into the chop lab');
      return;
    }
    const p = S.pads[S.selPad];
    p.buf = buf; p.start = 0; p.end = 1; p.name = f.name.replace(/\.[^.]+$/, '').slice(0, 24);
    drawPads(); drawEdit(); dirty();
    toast('Imported → pad ' + padLabel(S.selPad));
  } catch (err) { toast('Could not decode this file'); }
});

/* ------------------------------------------------ chop lab (field recording → slices) */
const CHOP_TARGET = -2;
const C = { buf: null, sr: 44100, markers: [], z: 1, off: 0, lastTap: -1, playhead: -1, auditionSrc: null, playFrom: 0, playTo: 1, playStart: 0 };
let chRecTimer = 0, gridSeq = [8, 16, 32, 4], gridPos = 0;
const fmtTime = s => Math.floor(s / 60) + ':' + ('0' + Math.floor(s % 60)).slice(-2);

async function startChopRecording() {
  await ensureAudio();
  try { await ensureMic(); } catch (e) { toast('Microphone unavailable: ' + e.message); return; }
  recKind = 'mic'; recChunks = []; recLen = 0; recTarget = CHOP_TARGET;
  recNode.port.postMessage('start');
  keepAwake(true);
  const b = $('#chRec'); b.classList.add('rec');
  chRecTimer = setInterval(() => { b.textContent = '● ' + fmtTime(recLen / ctx.sampleRate); }, 250);
  toast('Recording — walk around, tap ● to stop (max 6:00)');
}
function finalizeChopRecording() {
  clearInterval(chRecTimer);
  const b = $('#chRec'); b.classList.remove('rec'); b.textContent = '● REC';
  if (recLen < ctx.sampleRate * .2) { toast('Too short'); recChunks = []; return; }
  const buf = ctx.createBuffer(1, recLen, ctx.sampleRate);
  const L = buf.getChannelData(0); let o = 0;
  for (const c of recChunks) { L.set(c.L, o); o += c.L.length; }
  recChunks = [];
  C.buf = buf; C.sr = ctx.sampleRate; C.markers = []; C.z = 1; C.off = 0; C.lastTap = -1;
  $('#chZoom').value = 0; $('#chZoomOut').textContent = '1×';
  drawChop(); dirty(); saveChopSource();
  $('#chopGo').classList.add('on'); // one-tap quick path: auto-slice + spread to pads
}
$('#chopGoBtn').onclick = () => {
  $('#chopGo').classList.remove('on');
  if (!C.buf) return;
  autoSlice();
  if (!C.markers.length) { // uneventful texture — fall back to 8 equal cuts
    C.markers = []; for (let i = 1; i < 8; i++) C.markers.push(i / 8);
    drawChop();
  }
  chopToPads();
};
$('#chopGoX').onclick = () => $('#chopGo').classList.remove('on');
$('#chRec').onclick = () => { if (recTarget === CHOP_TARGET) stopRecording(); else startChopRecording(); };
$('#chImport').onclick = () => { importDest = 'chop'; $('#fileIn').click(); };

/* --- chop persistence: the long source is saved once per capture, not on every edit --- */
async function saveChopSource() {
  try {
    const d = await idb();
    const payload = C.buf ? { L: C.buf.getChannelData(0).slice(0), sr: C.sr } : null;
    await new Promise((res, rej) => {
      const tx = d.transaction('projects', 'readwrite');
      tx.objectStore('projects').put(payload, '__chopsrc');
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch (e) {}
}
async function loadChopSource() {
  try {
    const d = await idb();
    const data = await new Promise(res => {
      const rq = d.transaction('projects').objectStore('projects').get('__chopsrc');
      rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null);
    });
    if (!data || !ctx) return;
    const buf = ctx.createBuffer(1, data.L.length, data.sr);
    buf.getChannelData(0).set(data.L);
    C.buf = buf; C.sr = data.sr;
    drawChop();
  } catch (e) {}
}

/* --- slicing --- */
function sortedMarkers() { return [...C.markers].sort((a, b) => a - b); }
function autoSlice() {
  if (!C.buf) { toast('Record or import first'); return; }
  const d = C.buf.getChannelData(0), sr = C.sr;
  const hop = Math.floor(sr * .02), n = Math.floor(d.length / hop);
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0; const base = i * hop;
    for (let j = 0; j < hop; j += 4) { const v = d[base + j]; s += v * v; }
    rms[i] = Math.sqrt(s / (hop / 4));
  }
  const sens = +$('#chSens').value;               // higher = more slices
  const k = 1.35 + (100 - sens) / 100 * 2.2;      // onset must exceed k× running average
  const minGap = .25 + (100 - sens) / 100 * .75;  // seconds between onsets
  const marks = []; let avg = rms[0] || 1e-4, last = -1e9;
  for (let i = 2; i < n; i++) {
    avg = avg * .95 + rms[i - 1] * .05;
    if (rms[i] > avg * k && rms[i] > .01 && i * hop / sr - last > minGap) {
      last = i * hop / sr;
      marks.push(Math.max(0, i - 1) * hop / d.length);
    }
  }
  C.markers = marks.filter(m => m > .002 && m < .998);
  drawChop(); dirty();
  toast(C.markers.length ? C.markers.length + 1 + ' slices found' : 'No clear events — raise sens or use GRID');
}
$('#chAuto').onclick = autoSlice;
$('#chGrid').onclick = () => {
  if (!C.buf) { toast('Record or import first'); return; }
  const n = gridSeq[gridPos]; gridPos = (gridPos + 1) % gridSeq.length;
  C.markers = []; for (let i = 1; i < n; i++) C.markers.push(i / n);
  $('#chGrid').textContent = 'GRID ' + gridSeq[gridPos];
  drawChop(); dirty(); toast(n + ' equal slices');
};
$('#chClear').onclick = () => { C.markers = []; C.lastTap = -1; drawChop(); dirty(); };
$('#chAdd').onclick = () => {
  if (!C.buf) return;
  if (C.lastTap < 0) { toast('Tap the wave first to place the cursor'); return; }
  C.markers.push(C.lastTap); drawChop(); dirty();
};
$('#chToPads').onclick = () => chopToPads();
function chopToPads() {
  if (!C.buf) { toast('Record or import first'); return; }
  const bs = [0, ...sortedMarkers(), 1], d = C.buf.getChannelData(0);
  const slices = [];
  for (let i = 0; i < bs.length - 1; i++) if (bs[i + 1] - bs[i] > .0005) slices.push([bs[i], bs[i + 1]]);
  let assigned = 0, firstIdx = -1;
  for (const [a, b] of slices) {
    const idx = S.pads.findIndex(p => !p.buf);
    if (idx < 0) break;
    const s = Math.floor(a * d.length), e = Math.floor(b * d.length);
    const nb = ctx.createBuffer(2, e - s, C.sr);
    nb.getChannelData(0).set(d.subarray(s, e)); nb.getChannelData(1).set(d.subarray(s, e));
    S.pads[idx] = Object.assign(newPad(), { buf: nb, name: 'cut' + (assigned + 1) });
    if (firstIdx < 0) firstIdx = idx;
    assigned++;
  }
  if (!assigned) { toast('No empty pads — clear some first'); return; }
  S.selPad = firstIdx; S.bank = Math.floor(firstIdx / PADS_PER_BANK);
  drawPads(); dirty();
  toast(assigned + ' slices → pads' + (assigned < slices.length ? ' (' + (slices.length - assigned) + " didn't fit)" : ''));
  gotoTab('pads');
}
$('#chKeep').onclick = () => {
  if (!C.buf) { toast('Record or import first'); return; }
  const idx = S.pads.findIndex(p => !p.buf);
  if (idx < 0) { toast('No empty pads'); return; }
  const d = C.buf.getChannelData(0), nb = ctx.createBuffer(2, d.length, C.sr);
  nb.getChannelData(0).set(d); nb.getChannelData(1).set(d);
  S.pads[idx] = Object.assign(newPad(), { buf: nb, name: 'field ' + fmtTime(C.buf.duration) });
  S.selPad = idx; drawPads(); dirty();
  toast('Full recording → pad ' + padLabel(idx));
};
$('#chExport').onclick = () => {
  if (!C.buf) { toast('Record or import first'); return; }
  const d = C.buf.getChannelData(0);
  saveWav(encodeWav(d, d, C.sr), safeName(S.projName) + '-field.wav');
};

/* --- audition --- */
function auditionAt(frac) {
  const bs = [0, ...sortedMarkers(), 1];
  let a = 0, b = 1;
  for (let i = 0; i < bs.length - 1; i++) if (frac >= bs[i] && frac < bs[i + 1]) { a = bs[i]; b = bs[i + 1]; break; }
  C.lastTap = frac;
  if (C.auditionSrc) { try { C.auditionSrc.stop(); } catch (e) {} }
  const src = ctx.createBufferSource();
  src.buffer = C.buf; src.connect(master.in);
  src.start(0, a * C.buf.duration, (b - a) * C.buf.duration);
  C.auditionSrc = src; C.playStart = ctx.currentTime; C.playFrom = a; C.playTo = b;
  src.onended = () => { if (C.auditionSrc === src) { C.auditionSrc = null; C.playhead = -1; drawChop(); } };
  animateChopPlayhead();
}
function animateChopPlayhead() {
  if (!C.auditionSrc) return;
  C.playhead = C.playFrom + (ctx.currentTime - C.playStart) / C.buf.duration;
  if (C.playhead >= C.playTo) { C.playhead = -1; drawChop(); return; }
  drawChop();
  requestAnimationFrame(animateChopPlayhead);
}

/* --- canvas + gestures --- */
const chCanvas = $('#chopCanvas'), chCtx2 = chCanvas.getContext('2d');
function chVisible() { return 1 / C.z; }
function chXToFrac(px, rect) { return clamp(C.off + (px - rect.left) / rect.width * chVisible(), 0, 1); }
function chFracToX(f, W) { return (f - C.off) / chVisible() * W; }
function drawChop() {
  const W = chCanvas.width = chCanvas.clientWidth * devicePixelRatio;
  const H = chCanvas.height = chCanvas.clientHeight * devicePixelRatio;
  chCtx2.clearRect(0, 0, W, H);
  if (!C.buf) {
    chCtx2.fillStyle = '#3a4258'; chCtx2.font = 12 * devicePixelRatio + 'px sans-serif'; chCtx2.textAlign = 'center';
    chCtx2.fillText('tap ● REC and go for a walk — or IMPORT a recording', W / 2, H / 2);
    $('#chTime').textContent = '';
    return;
  }
  const d = C.buf.getChannelData(0), vis = chVisible();
  const s0 = Math.floor(C.off * d.length), sN = Math.floor((C.off + vis) * d.length);
  const perCol = Math.max(1, Math.floor((sN - s0) / W));
  chCtx2.strokeStyle = '#5b8bd9'; chCtx2.lineWidth = 1; chCtx2.beginPath();
  for (let x = 0; x < W; x++) {
    const base = s0 + x * perCol; let mn = 1, mx = -1;
    for (let i = 0; i < perCol; i += Math.max(1, perCol >> 4)) { const v = d[base + i] || 0; if (v < mn) mn = v; if (v > mx) mx = v; }
    chCtx2.moveTo(x, H / 2 + mn * H * .46); chCtx2.lineTo(x, H / 2 + mx * H * .46 + 1);
  }
  chCtx2.stroke();
  for (const m of sortedMarkers()) {
    const x = chFracToX(m, W);
    if (x < 0 || x > W) continue;
    chCtx2.fillStyle = '#3ddc97';
    chCtx2.fillRect(x - devicePixelRatio, 0, 2 * devicePixelRatio, H);
    chCtx2.beginPath(); chCtx2.arc(x, H - 10 * devicePixelRatio, 7 * devicePixelRatio, 0, 7); chCtx2.fill();
  }
  if (C.lastTap >= 0) {
    const x = chFracToX(C.lastTap, W);
    chCtx2.strokeStyle = '#ffb02e'; chCtx2.setLineDash([4 * devicePixelRatio, 4 * devicePixelRatio]);
    chCtx2.beginPath(); chCtx2.moveTo(x, 0); chCtx2.lineTo(x, H); chCtx2.stroke(); chCtx2.setLineDash([]);
  }
  if (C.playhead >= 0) {
    const x = chFracToX(C.playhead, W);
    chCtx2.fillStyle = '#e8ecf5'; chCtx2.fillRect(x, 0, 1.5 * devicePixelRatio, H);
  }
  $('#chTime').textContent = fmtTime(C.buf.duration) + ' · ' + (C.markers.length + 1) + ' slices';
}
let chDrag = null, chHoldTimer = 0;
const chopBox = $('#chopWaveBox');
chopBox.addEventListener('pointerdown', ev => {
  if (!C.buf) return;
  chopBox.setPointerCapture(ev.pointerId);
  const rect = chCanvas.getBoundingClientRect();
  const frac = chXToFrac(ev.clientX, rect);
  const thresh = 12 / rect.width * chVisible();
  let mi = -1, best = thresh;
  C.markers.forEach((m, i) => { const dd = Math.abs(m - frac); if (dd < best) { best = dd; mi = i; } });
  if (mi >= 0) {
    chDrag = { type: 'marker', i: mi, moved: false };
    chHoldTimer = setTimeout(() => {
      C.markers.splice(mi, 1); chDrag = null; drawChop(); dirty(); toast('Marker removed');
    }, 600);
  } else {
    chDrag = { type: 'pan', x0: ev.clientX, off0: C.off, moved: false, t0: performance.now(), frac };
  }
});
chopBox.addEventListener('pointermove', ev => {
  if (!chDrag || !ev.buttons) return;
  const rect = chCanvas.getBoundingClientRect();
  if (chDrag.type === 'marker') {
    if (!chDrag.moved && Math.abs(ev.movementX) + Math.abs(ev.movementY) > 2) { chDrag.moved = true; clearTimeout(chHoldTimer); }
    if (chDrag.moved) { C.markers[chDrag.i] = clamp(chXToFrac(ev.clientX, rect), .001, .999); drawChop(); }
  } else {
    const dx = ev.clientX - chDrag.x0;
    if (Math.abs(dx) > 6) chDrag.moved = true;
    C.off = clamp(chDrag.off0 - dx / rect.width * chVisible(), 0, 1 - chVisible());
    drawChop();
  }
});
chopBox.addEventListener('pointerup', ev => {
  clearTimeout(chHoldTimer);
  if (!chDrag) return;
  if (chDrag.type === 'pan' && !chDrag.moved && performance.now() - chDrag.t0 < 400) auditionAt(chDrag.frac);
  if (chDrag.type === 'marker') dirty();
  chDrag = null;
  drawChop();
});
chopBox.addEventListener('pointercancel', () => {
  clearTimeout(chHoldTimer); chDrag = null; drawChop();
});
$('#chZoom').oninput = e => {
  C.z = Math.pow(50, e.target.value / 100);
  C.off = clamp(C.off, 0, 1 - chVisible());
  $('#chZoomOut').textContent = C.z.toFixed(1) + '×';
  drawChop();
};
$('#chSens').oninput = e => { $('#chSensOut').textContent = e.target.value; };

/* ------------------------------------------------ Saigon Sound Map library */
const SSM = 'https://saigon-soundscape.onrender.com/api';
let libRows = null, libAudio = null, libPlayingBtn = null;

function openLib() {
  $('#lib').classList.add('on');
  if (libRows) drawLib(); else loadLib();
}
function closeLib() {
  $('#lib').classList.remove('on');
  stopPreview();
}
$('#mLib').onclick = () => { $('#menu').classList.remove('on'); openLib(); };
$('#chLib').onclick = openLib;
$('#libClose').onclick = closeLib;

async function loadLib() {
  $('#libList').innerHTML = '<div id="libStatus">loading the archive…<br><small>(first load can take ~30s while the server wakes)</small></div>';
  try {
    const res = await fetch(SSM + '/recordings');
    const data = await res.json();
    libRows = data.recordings.map(r => ({
      id: r.id, title: (r.title || 'untitled').replace(/^\[[^\]]*\]\s*/, ''),
      cat: r.category || '', dur: r.duration || 0, desc: (r.description || '').slice(0, 120),
    }));
    try { localStorage.setItem('sst_lib', JSON.stringify(libRows)); } catch (e) {}
  } catch (err) {
    try { libRows = JSON.parse(localStorage.getItem('sst_lib')); } catch (e) {}
    if (!libRows) {
      $('#libList').innerHTML = '<div id="libStatus">Couldn\'t reach the Sound Map — check your connection and reopen.</div>';
      return;
    }
    toast('Offline — showing the cached list (loading audio needs network)');
  }
  const cats = [...new Set(libRows.map(r => r.cat).filter(Boolean))].sort();
  const sel = $('#libCat');
  sel.innerHTML = '<option value="">all categories</option>' + cats.map(c => '<option>' + c + '</option>').join('');
  drawLib();
}

function drawLib() {
  const q = $('#libSearch').value.trim().toLowerCase(), cat = $('#libCat').value;
  const rows = libRows.filter(r =>
    (!cat || r.cat === cat) &&
    (!q || (r.title + ' ' + r.desc + ' ' + r.cat).toLowerCase().includes(q)));
  $('#libCount').textContent = rows.length + '/' + libRows.length;
  const el = $('#libList'); el.innerHTML = '';
  if (!rows.length) { el.innerHTML = '<div id="libStatus">nothing matches</div>'; return; }
  for (const r of rows) {
    const row = document.createElement('div'); row.className = 'libRow';
    const info = document.createElement('div'); info.className = 'libInfo';
    info.innerHTML = '<div class="t"></div><div class="m"></div>';
    info.querySelector('.t').textContent = r.title;
    info.querySelector('.m').textContent = r.cat + ' · ' + fmtTime(r.dur);
    const pv = document.createElement('button'); pv.className = 'pv'; pv.textContent = '▶';
    pv.onclick = () => togglePreview(r, pv);
    const toChop = document.createElement('button'); toChop.textContent = '→ CHOP';
    toChop.onclick = () => libLoad(r, toChop, 'chop');
    const toPad = document.createElement('button'); toPad.textContent = '→ PAD';
    toPad.onclick = () => libLoad(r, toPad, 'pad');
    row.append(pv, info, toChop, toPad);
    el.appendChild(row);
  }
}
let libSearchT = 0;
$('#libSearch').addEventListener('input', () => { clearTimeout(libSearchT); libSearchT = setTimeout(drawLib, 160); });
$('#libCat').onchange = drawLib;
$('#libShuffle').onclick = () => {
  if (!libRows) return;
  for (let i = libRows.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [libRows[i], libRows[j]] = [libRows[j], libRows[i]]; }
  drawLib();
};

function libUrl(r) { return SSM + '/download/' + r.id.slice(0, 8); }
function stopPreview() {
  if (libAudio) { try { libAudio.pause(); } catch (e) {} }
  if (libPlayingBtn) { libPlayingBtn.textContent = '▶'; libPlayingBtn.classList.remove('playing'); libPlayingBtn = null; }
}
function togglePreview(r, btn) {
  if (libPlayingBtn === btn) { stopPreview(); return; }
  stopPreview();
  if (!libAudio) { libAudio = new Audio(); libAudio.preload = 'none'; }
  libAudio.src = libUrl(r);
  libAudio.play().then(() => {
    libPlayingBtn = btn; btn.textContent = '■'; btn.classList.add('playing');
    libAudio.onended = stopPreview;
  }).catch(() => toast('Preview failed — check connection'));
}

async function libLoad(r, btn, dest) {
  if (btn.disabled) return;
  const label = btn.textContent; btn.disabled = true; btn.textContent = '…';
  stopPreview();
  try {
    await ensureAudio();
    const ab = await (await fetch(libUrl(r))).arrayBuffer();
    const buf = await ctx.decodeAudioData(ab);
    if (dest === 'chop') {
      const mono = ctx.createBuffer(1, buf.length, buf.sampleRate);
      const L = mono.getChannelData(0), a = buf.getChannelData(0);
      const b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
      for (let i = 0; i < buf.length; i++) L[i] = (a[i] + b[i]) / 2;
      C.buf = mono; C.sr = buf.sampleRate; C.markers = []; C.z = 1; C.off = 0; C.lastTap = -1;
      drawChop(); dirty(); saveChopSource();
      closeLib(); gotoTab('chop');
      $('#chopGo').classList.add('on');
      toast('"' + r.title + '" in the chop lab');
    } else {
      const idx = S.pads.findIndex(p => !p.buf);
      if (idx < 0) { toast('No empty pads'); btn.disabled = false; btn.textContent = label; return; }
      const nb = ctx.createBuffer(2, buf.length, buf.sampleRate);
      nb.getChannelData(0).set(buf.getChannelData(0));
      nb.getChannelData(1).set(buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0));
      S.pads[idx] = Object.assign(newPad(), { buf: nb, name: r.title.slice(0, 24) });
      S.selPad = idx; S.bank = Math.floor(idx / PADS_PER_BANK);
      drawPads(); dirty();
      toast('"' + r.title.slice(0, 20) + '" → pad ' + padLabel(idx));
    }
  } catch (err) {
    toast('Load failed — check connection');
  }
  btn.disabled = false; btn.textContent = label;
}

/* ------------------------------------------------ WAV + export */
function encodeWav(chL, chR, sr) {
  const n = chL.length, buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, n * 4, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    v.setInt16(o, clamp(chL[i], -1, 1) * 32767, true); o += 2;
    v.setInt16(o, clamp(chR[i], -1, 1) * 32767, true); o += 2;
  }
  return buf;
}

function saveWav(arrayBuf, name) {
  if (window.__TEST_CAPTURE) { window.__lastWav = { buf: arrayBuf, name }; toast('test-captured ' + name); return; }
  if (window.GibbonBridge && GibbonBridge.saveFile) {
    // chunked base64 to avoid giant single string ops
    const bytes = new Uint8Array(arrayBuf); let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    GibbonBridge.saveFile(name, btoa(bin));
    toast('Saved to Downloads: ' + name);
  } else if (IS_IOS) {
    /* navigator.share needs fresh user activation, which is gone after async
     * renders — and <a download> is inert in an installed iOS web app. So on
     * iOS every export parks here and the SAVE bar's own tap does the share. */
    pendingSave = { blob: new Blob([arrayBuf], { type: 'audio/wav' }), name };
    $('#saveBarLabel').textContent = name + ' ready';
    $('#saveBar').classList.add('on');
  } else {
    const blob = new Blob([arrayBuf], { type: 'audio/wav' });
    const a = document.createElement('a');
    const u = URL.createObjectURL(blob);
    a.href = u; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(u), 60000);
    toast('Exported ' + name);
  }
}
const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let pendingSave = null;
$('#btnSaveWav').addEventListener('click', () => {
  if (!pendingSave) { $('#saveBar').classList.remove('on'); return; }
  const { blob, name } = pendingSave;
  const file = new File([blob], name, { type: 'audio/wav' });
  const done = () => { pendingSave = null; $('#saveBar').classList.remove('on'); };
  // share() is called synchronously inside this tap — activation is valid here
  const p = (navigator.canShare && navigator.canShare({ files: [file] }))
    ? navigator.share({ files: [file] })
    : Promise.reject({ name: 'NoShare' });
  p.then(done).catch(e => {
    if (e && e.name === 'AbortError') return; // user closed the sheet — keep the bar for retry
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (!standalone) {
      const a = document.createElement('a');
      const u = URL.createObjectURL(blob);
      a.href = u; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(u), 60000);
      done(); toast('Downloaded ' + name);
    } else toast('Share failed — tap SAVE to retry');
  });
});

/* iOS audio session: a WebAudio-only page runs "ambient" and the ring/silent
 * switch mutes it. Prefer the Audio Session API; where absent, a looping
 * silent <audio> element promotes the session to playback. */
try { if ('audioSession' in navigator) navigator.audioSession.type = 'playback'; } catch (e) {}
let iosUnlockEl = null;
function iosAudioUnlock() {
  if (!IS_IOS || ('audioSession' in navigator)) return;
  if (!iosUnlockEl) {
    iosUnlockEl = document.createElement('audio');
    iosUnlockEl.loop = true;
    iosUnlockEl.setAttribute('playsinline', '');
    iosUnlockEl.src = URL.createObjectURL(
      new Blob([encodeWav(new Float32Array(400), new Float32Array(400), 8000)], { type: 'audio/wav' }));
  }
  if (iosUnlockEl.paused) iosUnlockEl.play().catch(() => {});
}

/* recover from interruptions (calls, route changes, backgrounding) on real
 * activation-granting gestures — iOS does not count touch-derived pointerdown */
function tryResume() {
  if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  iosAudioUnlock();
}
document.addEventListener('pointerup', tryResume, true);
document.addEventListener('click', tryResume, true);

/* keep the screen awake while playing or recording (Android shell does this natively) */
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (S.playing || recTarget !== -1) keepAwake(true);
  if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  if (iosUnlockEl && iosUnlockEl.paused) iosUnlockEl.play().catch(() => {});
});

async function renderPatterns(patIdxList, name) {
  await ensureAudio();
  const td = tickDur();
  let total = 0;
  const spans = patIdxList.map(pi => {
    const r = { pi, at: total };
    total += seqTicks(S.patterns[pi]) * td;
    return r;
  });
  const sr = ctx.sampleRate, oc = new OfflineAudioContext(2, Math.ceil((total + 2) * sr), sr);
  const comp = oc.createDynamicsCompressor();
  comp.threshold.value = -12; comp.ratio.value = 4; comp.attack.value = .003; comp.release.value = .12;
  comp.connect(oc.destination);
  for (const span of spans) {
    const pat = S.patterns[span.pi];
    for (const ev of pat.events) {
      const t = span.at + (ev.t + swingDelayTicks(ev.t)) * td;
      triggerPad(ev.pad, t, ev.o, comp, oc, ev.vel);
    }
  }
  toast('Rendering…');
  const out = await oc.startRendering();
  saveWav(encodeWav(out.getChannelData(0), out.getChannelData(1), sr), name);
}

function exportPad() {
  const p = S.pads[S.selPad];
  if (!p.buf) { toast('Selected pad is empty'); return; }
  const b = p.buf, s = Math.floor(p.start * b.length), e = Math.floor(p.end * b.length);
  const L = b.getChannelData(0).slice(s, e);
  const R = (b.numberOfChannels > 1 ? b.getChannelData(1) : b.getChannelData(0)).slice(s, e);
  saveWav(encodeWav(L, R, b.sampleRate), safeName(p.name || 'pad') + '.wav');
}
const safeName = n => n.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'gibbon';

/* ------------------------------------------------ persistence (IndexedDB) */
let db = null;
function idb() {
  return new Promise((res, rej) => {
    if (db) return res(db);
    const rq = indexedDB.open('gibbon', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('projects');
    rq.onsuccess = () => { db = rq.result; res(db); };
    rq.onerror = () => rej(rq.error);
  });
}
function serialize() {
  return {
    v: 3, bpm: S.bpm, swing: S.swing, tc: S.tc, chain: S.chain.map(c => ({ seq: c.seq, reps: c.reps })),
    scale: S.scale, name: S.projName, chopMarkers: C.markers.slice(),
    patterns: S.patterns.map(p => ({
      bars: p.bars,
      events: p.events.map(ev => [ev.t, ev.pad, ev.vel, ev.o || 0]),
    })),
    pads: S.pads.map(p => !p.buf ? null : {
      name: p.name, gain: p.gain, pan: p.pan, semis: p.semis, fine: p.fine, mode: p.mode, choke: p.choke,
      start: p.start, end: p.end, attack: p.attack, release: p.release,
      cutoff: p.cutoff, res: p.res, mono: p.mono, velFilt: p.velFilt, mute: p.mute,
      sr: p.buf.sampleRate,
      L: p.buf.getChannelData(0).slice(0), R: (p.buf.numberOfChannels > 1 ? p.buf.getChannelData(1) : p.buf.getChannelData(0)).slice(0),
    }),
  };
}
function migrateSeq(raw) {
  if (raw.events) {
    return { bars: raw.bars || 2, events: raw.events.map(a => {
      const ev = { t: a[0], pad: a[1], vel: a[2] };
      if (a[3] && a[3] !== -1) ev.o = a[3]; // semitone offset (-1 was an old empty sentinel)
      return ev;
    }) };
  }
  // v1/v2: {len, steps:{pad: [0|1,...]}} at fixed 16th grid
  const seq = { bars: Math.max(1, Math.round((raw.len || 16) / 16)), events: [] };
  for (const k in (raw.steps || {})) {
    (raw.steps[k] || []).forEach((on, st) => { if (on) seq.events.push({ t: st * STEP_T, pad: +k, vel: 100 }); });
  }
  return seq;
}
async function saveProject(key) {
  const d = await idb();
  await new Promise((res, rej) => {
    const tx = d.transaction('projects', 'readwrite');
    tx.objectStore('projects').put(serialize(), key);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
async function loadProject(key) {
  const d = await idb();
  const data = await new Promise((res, rej) => {
    const rq = d.transaction('projects').objectStore('projects').get(key);
    rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
  });
  if (!data) return false;
  await ensureAudio();
  if (S.playing) stop();
  S.solo.clear(); takeSnapshot = null; heldPads.clear(); // no transient state bleeding across projects
  S.bpm = data.bpm; S.scale = data.scale || 'pmin';
  S.swing = data.swing >= 50 ? clamp(data.swing, 50, 75) : clamp(50 + Math.round((data.swing || 0) * 25 / 60), 50, 75);
  S.tc = data.tc && TC[data.tc] !== undefined ? data.tc : '16';
  S.chain = (data.chain || []).map(c => typeof c === 'number' ? { seq: c, reps: 1 } : c);
  S.projName = data.name || key;
  C.markers = data.chopMarkers || [];
  S.patterns = data.patterns.map(migrateSeq);
  while (S.patterns.length < NUM_PATTERNS) S.patterns.push(newSeq());
  S.pads = data.pads.map(p => {
    if (!p) return newPad();
    const buf = ctx.createBuffer(2, p.L.length, p.sr);
    buf.getChannelData(0).set(p.L); buf.getChannelData(1).set(p.R);
    return Object.assign(newPad(), {
      buf, name: p.name, gain: p.gain, pan: p.pan, semis: p.semis, fine: p.fine || 0,
      mode: p.mode, choke: p.choke, start: p.start, end: p.end,
      attack: p.attack || 0, release: p.release || 0, cutoff: p.cutoff || 20000, res: p.res || 0,
      mono: !!p.mono, velFilt: !!p.velFilt, mute: !!p.mute,
    });
  });
  while (S.pads.length < NUM_PADS) S.pads.push(newPad());
  S.pattern = 0; S.selPad = S.pads.findIndex(p => p.buf); if (S.selPad < 0) S.selPad = 0;
  drawAll();
  return true;
}
async function listProjects() {
  const d = await idb();
  return new Promise(res => {
    const rq = d.transaction('projects').objectStore('projects').getAllKeys();
    rq.onsuccess = () => res(rq.result.filter(k => k !== '__auto'));
  });
}
async function deleteProject(key) {
  const d = await idb();
  return new Promise(res => {
    const tx = d.transaction('projects', 'readwrite');
    tx.objectStore('projects').delete(key); tx.oncomplete = res;
  });
}
let dirtyTimer = 0;
function dirty() {
  clearTimeout(dirtyTimer);
  dirtyTimer = setTimeout(() => { if (ctx) saveProject('__auto').catch(() => {}); }, 2500);
}

/* ------------------------------------------------ UI: topbar */
function drawTopbar() {
  $('#bpmVal').innerHTML = S.bpm + '<small> bpm</small>';
  $('#btnRec').classList.toggle('on', S.recArm || S.recordingPad >= 0);
  $('#btnMetro').classList.toggle('on', S.metro);
}
$('#bpmUp').onclick = () => { S.bpm = clamp(S.bpm + 1, 30, 300); drawTopbar(); dirty(); };
$('#bpmDown').onclick = () => { S.bpm = clamp(S.bpm - 1, 30, 300); drawTopbar(); dirty(); };
let holdIv = 0;
for (const [id, d] of [['#bpmUp', 1], ['#bpmDown', -1]]) {
  $(id).addEventListener('pointerdown', () => { holdIv = setInterval(() => { S.bpm = clamp(S.bpm + d, 30, 300); drawTopbar(); }, 90); });
  $(id).addEventListener('pointerup', () => { clearInterval(holdIv); dirty(); });
  $(id).addEventListener('pointerleave', () => clearInterval(holdIv));
  $(id).addEventListener('pointercancel', () => clearInterval(holdIv));
}
let taps = [];
$('#btnTap').onclick = () => {
  const now = performance.now();
  taps = taps.filter(t => now - t < 3000); taps.push(now);
  if (taps.length >= 3) {
    const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    S.bpm = clamp(Math.round(60000 / iv), 30, 300); drawTopbar(); dirty();
  }
};
$('#btnMetro').onclick = () => { S.metro = !S.metro; drawTopbar(); };
$('#btnPlay').onclick = async () => { if (S.playing) stop(); else await play(); };
/* ● button: tap = arm pad-sampling (or stop any recording); HOLD = start a
 * field recording instantly from any page — the moment on the street is short */
let recHoldTimer = 0, recHoldFired = false;
$('#btnRec').addEventListener('pointerdown', () => {
  recHoldFired = false;
  if (recTarget !== -1) return; // already recording something — tap will stop it
  recHoldTimer = setTimeout(async () => {
    recHoldTimer = 0; recHoldFired = true;
    await ensureAudio();
    gotoTab('chop');
    startChopRecording();
  }, 450);
});
for (const evName of ['pointerup', 'pointerleave', 'pointercancel'])
  $('#btnRec').addEventListener(evName, () => { if (recHoldTimer) { clearTimeout(recHoldTimer); recHoldTimer = 0; } });
$('#btnRec').onclick = async () => {
  if (recHoldFired) { recHoldFired = false; return; }
  await ensureAudio();
  if (recTarget === CHOP_TARGET) { stopRecording(); return; }
  if (S.recordingPad >= 0) { stopRecording(); return; }
  S.recArm = !S.recArm; drawTopbar();
  toast(S.recArm ? 'Armed — tap a pad to record from mic (hold ● for a field recording)' : 'Disarmed');
};
$('#btnResampleStop').onclick = stopRecording;

/* ------------------------------------------------ UI: tabs */
$$('.tab').forEach(t => t.onclick = () => {
  $$('.tab').forEach(x => x.classList.remove('on'));
  $$('.page').forEach(x => x.classList.remove('on'));
  t.classList.add('on');
  $('#page-' + t.dataset.page).classList.add('on');
  try { localStorage.setItem('sst_tab', t.dataset.page); } catch (e) {}
  if (t.dataset.page === 'edit') drawEdit();
  if (t.dataset.page === 'seq') { drawSeqTop(); drawRowChips(); drawSteps(); }
  if (t.dataset.page === 'chop') drawChop();
  if (t.dataset.page === 'mix') drawMix();
});
function gotoTab(name) { $$('.tab').find(t => t.dataset.page === name).click(); }

/* ------------------------------------------------ UI: pads */
const bankRow = $('#bankRow'), padGrid = $('#padGrid');
for (let b = 0; b < NUM_BANKS; b++) {
  const el = document.createElement('div');
  el.className = 'bank'; el.textContent = 'BANK ' + 'ABCD'[b];
  el.onclick = () => { S.bank = b; drawPads(); if ($('#page-mix').classList.contains('on')) drawMix(); };
  bankRow.appendChild(el);
}
const padEls = [];
for (let i = 0; i < PADS_PER_BANK; i++) {
  const el = document.createElement('div');
  el.className = 'pad'; el.innerHTML = '<span class="lbl"></span><span class="num"></span>';
  padGrid.appendChild(el); padEls.push(el);
  let lpTimer = 0, played = false, playedIdx = -1;
  el.addEventListener('pointerdown', async ev => {
    ev.preventDefault(); played = false; playedIdx = -1;
    await ensureAudio();
    let idx = S.bank * PADS_PER_BANK + i;
    const perfMode = S.noteRepeat || S.erase || S.sixteen || S.keys;
    if (!perfMode) lpTimer = setTimeout(() => { lpTimer = 0; S.selPad = idx; drawPads(); gotoTab('edit'); }, 480);
    if (S.recArm && S.recordingPad < 0) { clearTimeout(lpTimer); lpTimer = 0; startMicRecording(idx); return; }
    if (S.recordingPad === idx) { clearTimeout(lpTimer); lpTimer = 0; stopRecording(); return; }

    // touch velocity: lower on the pad = harder hit (FULL LVL overrides)
    let vel = 127;
    if (!S.fullLevel) {
      const r = el.getBoundingClientRect();
      vel = Math.round(clamp(30 + 97 * (ev.clientY - r.top) / r.height, 30, 127));
    }
    let off = 0;
    if (S.sixteen) {
      idx = S.levelsPad;
      off = gridSemiOff(i);
      if (S.sixteen === 'vel') vel = (gridDegree(i) + 1) * 8 - 1; // levels 1-16 → vel 7..127
    } else if (S.keys) { idx = S.selPad; off = gridSemiOff(i); }

    const p = S.pads[idx];
    if (!p.buf) { if (!S.sixteen && !S.keys) { S.selPad = idx; drawPads(); } return; }

    if (S.erase) {
      heldPads.set(i, { idx, vel, off });
      playedIdx = idx;
      if (!S.playing) {
        const pat = S.patterns[S.pattern];
        const before = pat.events.length;
        pat.events = pat.events.filter(e2 => e2.pad !== idx);
        touchSeq(pat);
        if (pat.events.length !== before) { dirty(); drawRowChips(); drawSteps(); toast('Erased ' + padLabel(idx)); }
      }
      return;
    }

    if (!S.sixteen && !S.keys) S.selPad = idx;
    played = true; playedIdx = idx;
    heldPads.set(i, { idx, vel, off });
    if (p.mode === 'loop' && activeSrc.get(idx) && activeSrc.get(idx).length) { stopPad(idx); drawPads(); return; }

    if (S.noteRepeat && S.playing && TC[S.tc]) {
      // repeat mode while running: the scheduler fires it on the next grid point
    } else {
      triggerPad(idx, 0, off, null, null, vel);
      liveRecordNote(idx, vel, off);
    }
    el.classList.add('lit'); setTimeout(() => el.classList.remove('lit'), 130);
    drawPads();
  });
  const up = () => {
    if (lpTimer) { clearTimeout(lpTimer); lpTimer = 0; }
    const idx = playedIdx >= 0 ? playedIdx : S.bank * PADS_PER_BANK + i;
    heldPads.delete(i);
    if (played && S.pads[idx].mode === 'gate') stopPad(idx);
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointerleave', up);
  el.addEventListener('pointercancel', up);
}
function padLabel(idx) { return 'ABCD'[Math.floor(idx / PADS_PER_BANK)] + (idx % PADS_PER_BANK + 1); }

/* ---- performance toggles (MPC-style) ---- */
function drawPerf() {
  $('#pFull').classList.toggle('on', S.fullLevel);
  $('#pRepeat').classList.toggle('on', S.noteRepeat);
  $('#pLevels').classList.toggle('on', !!S.sixteen);
  $('#pLevels').textContent = S.sixteen === 'vel' ? '16 LVL·VEL' : S.sixteen === 'tune' ? '16 LVL·TUNE' : '16 LEVELS';
  $('#pErase').classList.toggle('on', S.erase);
}
$('#pFull').onclick = () => { S.fullLevel = !S.fullLevel; drawPerf(); };
$('#pRepeat').onclick = () => {
  S.noteRepeat = !S.noteRepeat;
  if (S.noteRepeat && !TC[S.tc]) toast('Note repeat follows TC — set TC on the SEQ page');
  drawPerf();
};
$('#pLevels').onclick = () => {
  S.sixteen = S.sixteen === null ? 'vel' : S.sixteen === 'vel' ? 'tune' : null;
  if (S.sixteen) { S.levelsPad = S.selPad; S.keys = false; toast('Pads = 16 ' + (S.sixteen === 'vel' ? 'velocity' : 'tune') + ' levels of ' + padLabel(S.levelsPad)); }
  drawPerf(); drawPads();
};
$('#pErase').onclick = () => {
  S.erase = !S.erase;
  toast(S.erase ? (S.playing ? 'Hold a pad to erase its notes as they pass' : 'Tap a pad to erase its notes in this sequence') : 'Erase off');
  drawPerf();
};
function drawPads() {
  $$('.bank').forEach((el, b) => el.classList.toggle('on', b === S.bank));
  $('#padHint').textContent = S.pads.some(p => p.buf)
    ? 'tap ● then a pad to sample from the mic · long-press a pad to select it for EDIT'
    : 'no sounds yet — HOLD ● to record the street, or tap ● then a pad to mic-sample · guide in ☰';
  for (let i = 0; i < PADS_PER_BANK; i++) {
    const idx = S.bank * PADS_PER_BANK + i, p = S.pads[idx], el = padEls[i];
    el.classList.toggle('filled', !!p.buf);
    el.classList.toggle('sel', idx === S.selPad);
    el.classList.toggle('armed', idx === S.recordingPad);
    el.querySelector('.lbl').textContent = p.buf ? (p.name || 'sample') : '';
    el.querySelector('.num').textContent = padLabel(idx);
  }
}

/* ------------------------------------------------ UI: sequencer */
let takeSnapshot = null;
function drawSeqTop() {
  const el = $('#seqTop'); el.innerHTML = '';
  for (let i = 0; i < NUM_PATTERNS; i++) {
    const b = document.createElement('button');
    b.className = 'patBtn' + (i === S.pattern ? ' on' : '');
    b.textContent = 'S' + (i + 1);
    b.onclick = () => { S.pattern = i; curTick = 0; touchSeq(S.patterns[i]); drawSeqTop(); drawRowChips(); drawSteps(); };
    // long-press a slot: copy the current sequence into it (MPC copy-sequence)
    let cpTimer = 0;
    b.addEventListener('pointerdown', () => {
      if (i === S.pattern) return;
      cpTimer = setTimeout(() => {
        cpTimer = 0;
        const src = S.patterns[S.pattern], old = S.patterns[i];
        takeSnapshot = { seq: i, events: old.events, bars: old.bars }; // UNDO on that slot restores it
        S.patterns[i] = { bars: src.bars, events: src.events.map(ev => ({ ...ev })) };
        toast('S' + (S.pattern + 1) + ' copied → S' + (i + 1) + ' (UNDO there restores)');
        dirty();
      }, 550);
    });
    for (const evName of ['pointerup', 'pointerleave', 'pointercancel'])
      b.addEventListener(evName, () => { if (cpTimer) { clearTimeout(cpTimer); cpTimer = 0; } });
    el.appendChild(b);
  }
  const pat = S.patterns[S.pattern];
  const bars = document.createElement('button');
  bars.className = 'seq-ctl'; bars.textContent = pat.bars + (pat.bars === 1 ? ' BAR' : ' BARS');
  bars.onclick = () => {
    pat.bars = { 1: 2, 2: 4, 4: 8, 8: 1 }[pat.bars];
    const total = seqTicks(pat);
    pat.events = pat.events.filter(ev => ev.t < total);
    touchSeq(pat); curTick = 0;
    drawSeqTop(); drawSteps(); dirty();
  };
  el.appendChild(bars);
  const tc = document.createElement('button');
  tc.className = 'seq-ctl'; tc.textContent = 'TC ' + (S.tc === 'OFF' ? 'OFF' : '1/' + S.tc);
  tc.onclick = () => {
    S.tc = TC_ORDER[(TC_ORDER.indexOf(S.tc) + 1) % TC_ORDER.length];
    drawSeqTop(); dirty();
  };
  el.appendChild(tc);
  const rec = document.createElement('button');
  rec.className = 'seq-ctl' + (S.noteRec ? ' on' : ''); rec.textContent = '● REC';
  rec.onclick = () => {
    S.noteRec = !S.noteRec;
    if (S.noteRec) takeSnapshot = { seq: S.pattern, events: pat.events.map(ev => ({ ...ev })), bars: pat.bars };
    drawSeqTop();
  };
  el.appendChild(rec);
  const undo = document.createElement('button');
  undo.className = 'seq-ctl'; undo.textContent = 'UNDO';
  undo.onclick = () => {
    if (!takeSnapshot || takeSnapshot.seq !== S.pattern) { toast('Nothing to undo here'); return; }
    // MPC-style: UNDO toggles between the take and the state before it
    const p = S.patterns[S.pattern];
    const curEv = p.events, curBars = p.bars;
    p.events = takeSnapshot.events;
    if (takeSnapshot.bars) p.bars = takeSnapshot.bars;
    takeSnapshot.events = curEv; takeSnapshot.bars = curBars;
    touchSeq(p);
    drawSeqTop(); drawRowChips(); drawSteps(); dirty(); toast('Take toggled — UNDO again to swap back');
  };
  el.appendChild(undo);
  const dup = document.createElement('button');
  dup.className = 'seq-ctl'; dup.textContent = 'DUP×2';
  dup.onclick = () => {
    // classic bar-copy: double the bars and copy all events into the new half
    if (pat.bars >= 8) { toast('Max 8 bars'); return; }
    const len = seqTicks(pat);
    pat.events = pat.events.concat(pat.events.map(ev => ({ ...ev, t: ev.t + len })));
    pat.bars *= 2;
    touchSeq(pat); drawSeqTop(); drawSteps(); dirty();
    toast(pat.bars / 2 + ' bar' + (pat.bars > 2 ? 's' : '') + ' copied → ' + pat.bars + ' bars');
  };
  el.appendChild(dup);
  const clr = document.createElement('button');
  clr.className = 'seq-ctl'; clr.textContent = 'CLEAR';
  clr.onclick = () => {
    takeSnapshot = { seq: S.pattern, events: pat.events.map(ev => ({ ...ev })), bars: pat.bars };
    pat.events = []; touchSeq(pat);
    drawRowChips(); drawSteps(); dirty();
  };
  el.appendChild(clr);
}
function drawRowChips() {
  const el = $('#rowChips'); el.innerHTML = '';
  const pat = S.patterns[S.pattern];
  const idxs = new Set(pat.events.map(ev => ev.pad));
  idxs.add(S.selPad);
  [...idxs].sort((a, b) => a - b).forEach(idx => {
    const c = document.createElement('button');
    c.className = 'chip' + (idx === S.selPad ? ' on' : '');
    c.textContent = padLabel(idx) + (S.pads[idx].name ? ' · ' + S.pads[idx].name.slice(0, 10) : '');
    c.onclick = () => { S.selPad = idx; drawRowChips(); drawSteps(); drawPads(); };
    el.appendChild(c);
  });
}
function drawSteps() {
  const el = $('#stepWrap'); el.innerHTML = '';
  const pat = S.patterns[S.pattern];
  const steps = pat.bars * 16;
  for (let r = 0; r < steps / 8; r++) {
    const row = document.createElement('div'); row.className = 'stepRow';
    for (let c = 0; c < 8; c++) {
      const st = r * 8 + c, s = document.createElement('div');
      const t0 = st * STEP_T, t1 = t0 + STEP_T;
      const cell = pat.events.filter(ev => ev.pad === S.selPad && ev.t >= t0 && ev.t < t1);
      s.className = 'step' + (st % 4 === 0 ? ' beat' : '') + (cell.length ? ' on' : '');
      if (cell.length) s.style.opacity = .45 + .55 * Math.max(...cell.map(ev => ev.vel)) / 127;
      s.dataset.st = st;
      s.onclick = () => {
        const hit = pat.events.filter(ev => ev.pad === S.selPad && ev.t >= t0 && ev.t < t1);
        if (hit.length) pat.events = pat.events.filter(ev => !hit.includes(ev));
        else pat.events.push({ t: t0, pad: S.selPad, vel: 100 });
        touchSeq(pat); dirty();
        drawRowChips(); drawSteps();
      };
      row.appendChild(s);
    }
    el.appendChild(row);
  }
}
let seqTouchT = 0;
$('#stepWrap').addEventListener('pointerdown', () => { seqTouchT = performance.now(); }, { passive: true });
function uiStep(st) {
  if (!$('#page-seq').classList.contains('on')) return;
  requestAnimationFrame(() => {
    $$('.step.cur').forEach(e => e.classList.remove('cur'));
    const el = document.querySelector('.step[data-st="' + st + '"]');
    if (el) {
      el.classList.add('cur');
      // follow the playhead on long sequences, but not while the user is editing
      if (performance.now() - seqTouchT > 1500) el.scrollIntoView({ block: 'nearest' });
    }
  });
}
$('#swing').oninput = e => { S.swing = +e.target.value; $('#swingOut').textContent = S.swing + '%'; dirty(); };

/* ------------------------------------------------ UI: mixer */
function drawMix() {
  const el = $('#mixWrap'); el.innerHTML = '';
  for (let i = 0; i < PADS_PER_BANK; i++) {
    const idx = S.bank * PADS_PER_BANK + i, p = S.pads[idx];
    const row = document.createElement('div'); row.className = 'mixRow';
    const lbl = document.createElement('div'); lbl.className = 'mLbl';
    lbl.textContent = padLabel(idx) + (p.name ? ' ' + p.name.slice(0, 8) : '');
    lbl.style.color = p.buf ? 'var(--txt)' : 'var(--dim)';
    const lv = document.createElement('input'); lv.type = 'range'; lv.min = 0; lv.max = 150; lv.value = Math.round(p.gain * 100);
    lv.oninput = () => { p.gain = lv.value / 100; dirty(); };
    const pn = document.createElement('input'); pn.type = 'range'; pn.min = -100; pn.max = 100; pn.value = Math.round(p.pan * 100);
    pn.style.maxWidth = '70px';
    pn.oninput = () => { p.pan = pn.value / 100; dirty(); };
    const m = document.createElement('button'); m.className = 'mBtn' + (p.mute ? ' mOn' : ''); m.textContent = 'M';
    m.onclick = () => { p.mute = !p.mute; if (p.mute) stopPad(idx); m.classList.toggle('mOn', p.mute); dirty(); };
    const s = document.createElement('button'); s.className = 'mBtn' + (S.solo.has(idx) ? ' sOn' : ''); s.textContent = 'S';
    s.onclick = () => { S.solo.has(idx) ? S.solo.delete(idx) : S.solo.add(idx); drawMix(); };
    row.append(lbl, lv, pn, m, s);
    el.appendChild(row);
  }
}

/* ------------------------------------------------ UI: FX */
const FX = {
  lpf:   { label: 'LO-PASS' }, hpf: { label: 'HI-PASS' }, delay: { label: 'DELAY' },
  verb:  { label: 'REVERB' }, crush: { label: 'CRUSH' }, gate: { label: 'GATE' },
};
const gateParams = { div: 2, depth: 0 };
const fxGrid = $('#fxGrid');
for (const key in FX) {
  const b = document.createElement('button');
  b.className = 'fxBtn'; b.textContent = FX[key].label; b.dataset.fx = key;
  b.addEventListener('pointerdown', async ev => {
    ev.preventDefault(); await ensureAudio();
    if (S.fxLatch && S.fx === key) { clearFx(); return; }
    S.fx = key; applyFx(); drawFx();
  });
  b.addEventListener('pointerup', () => { if (!S.fxLatch) clearFx(); });
  b.addEventListener('pointercancel', () => { if (!S.fxLatch) clearFx(); });
  fxGrid.appendChild(b);
}
function drawFx() {
  $$('.fxBtn').forEach(b => b.classList.toggle('on', b.dataset.fx === S.fx));
  $('#btnLatch').textContent = 'LATCH: ' + (S.fxLatch ? 'ON' : 'OFF');
  $('#btnLatch').classList.toggle('on', S.fxLatch);
  const d = $('#xyDot');
  d.style.left = S.fxXY.x * 100 + '%'; d.style.top = S.fxXY.y * 100 + '%';
  $('#xyLabel').textContent = S.fx ? FX[S.fx].label + ' — x/y morph' : 'hold an FX, drag to perform';
}
function applyFx() {
  if (!ctx) return;
  const { x, y } = S.fxXY, t = ctx.currentTime, m = master;
  const fast = (p, v) => p.setTargetAtTime(v, t, .02);
  // reset all
  fast(m.lp.frequency, 20000); fast(m.lp.Q, .7);
  fast(m.hp.frequency, 10); fast(m.hp.Q, .7);
  fast(m.dSend.gain, 0); fast(m.rSend.gain, 0);
  m.crush.port.postMessage({ wet: 0 });
  gateParams.depth = 0;
  m.gate.gain.cancelScheduledValues(t); fast(m.gate.gain, 1); // always release the gate, playing or not
  switch (S.fx) {
    case 'lpf': fast(m.lp.frequency, 80 * Math.pow(250, x)); fast(m.lp.Q, .7 + (1 - y) * 11); break;
    case 'hpf': fast(m.hp.frequency, 40 * Math.pow(250, x)); fast(m.hp.Q, .7 + (1 - y) * 11); break;
    case 'delay': {
      const beats = [1, .75, .5, .375, .25, .125][Math.floor(x * 5.99)];
      fast(m.delay.delayTime, clamp(stepDur() * 4 * beats, .02, 2));
      fast(m.dFb.gain, .2 + (1 - y) * .65); fast(m.dSend.gain, .6); break;
    }
    case 'verb': fast(m.rSend.gain, x * 1.2); fast(m.dTone.frequency, 4000); break;
    case 'crush': m.crush.port.postMessage({ wet: 1, bits: Math.round(12 - x * 9), down: 1 + Math.round((1 - y) * 24) }); break;
    case 'gate': gateParams.div = [8, 4, 2, 1][Math.floor(x * 3.99)]; gateParams.depth = .3 + (1 - y) * .7; break;
  }
}
function clearFx() {
  S.fx = null; applyFx(); drawFx();
  if (ctx && !S.playing) { master.gate.gain.cancelScheduledValues(ctx.currentTime); master.gate.gain.value = 1; }
}
$('#btnLatch').onclick = () => { S.fxLatch = !S.fxLatch; if (!S.fxLatch) clearFx(); drawFx(); };
$('#btnFxClear').onclick = clearFx;
const xy = $('#xyPad');
function xyMove(ev) {
  const r = xy.getBoundingClientRect();
  S.fxXY.x = clamp((ev.clientX - r.left) / r.width, 0, 1);
  S.fxXY.y = clamp((ev.clientY - r.top) / r.height, 0, 1);
  applyFx(); drawFx();
}
xy.addEventListener('pointerdown', ev => { xy.setPointerCapture(ev.pointerId); xyMove(ev); });
xy.addEventListener('pointermove', ev => { if (ev.buttons) xyMove(ev); });

/* ------------------------------------------------ UI: edit */
const wave = $('#waveCanvas'), wctx = wave.getContext('2d');
let dragHandle = null;
function drawEdit() {
  const p = S.pads[S.selPad];
  $('#editTitle').textContent = padLabel(S.selPad) + (p.name ? ' · ' + p.name : ' · empty');
  $('#editMeta').textContent = p.buf ? p.buf.duration.toFixed(2) + 's @ ' + p.buf.sampleRate + 'Hz' : '';
  $('#cGain').value = Math.round(p.gain * 100); $('#oGain').textContent = Math.round(p.gain * 100) + '%';
  $('#cPitch').value = p.semis; $('#oPitch').textContent = p.semis + ' st';
  $('#cFine').value = p.fine; $('#oFine').textContent = p.fine + ' ct';
  $('#cPan').value = Math.round(p.pan * 100); $('#oPan').textContent = p.pan === 0 ? 'C' : (p.pan < 0 ? 'L' : 'R') + Math.abs(Math.round(p.pan * 100));
  $('#cAtk').value = p.attack; $('#oAtk').textContent = p.attack + 'ms';
  $('#cRel').value = p.release; $('#oRel').textContent = p.release + 'ms';
  $('#cCut').value = cutToSlider(p.cutoff); $('#oCut').textContent = p.cutoff >= 19000 ? 'off' : (p.cutoff >= 1000 ? (p.cutoff / 1000).toFixed(1) + 'k' : Math.round(p.cutoff));
  $('#cRes').value = Math.round(p.res * 10); $('#oRes').textContent = p.res.toFixed(1);
  $('#bMode').textContent = { oneshot: 'ONE-SHOT', gate: 'GATE', loop: 'LOOP' }[p.mode];
  $('#bChoke').textContent = 'CHOKE: ' + (p.choke ? p.choke : '–');
  $('#bMono').textContent = p.mono ? 'MONO' : 'POLY';
  $('#bMono').classList.toggle('on', p.mono);
  $('#bVelFilt').textContent = 'VEL→FILT: ' + (p.velFilt ? 'ON' : 'OFF');
  $('#bVelFilt').classList.toggle('on', p.velFilt);
  $('#bKeys').textContent = 'KEYBOARD MODE: ' + (S.keys ? 'ON' : 'OFF');
  $('#bKeys').classList.toggle('on', S.keys);
  $('#selScale').value = S.scale;
  drawWave();
}
function drawWave() {
  const p = S.pads[S.selPad];
  const W = wave.width = wave.clientWidth * devicePixelRatio, H = wave.height = wave.clientHeight * devicePixelRatio;
  wctx.clearRect(0, 0, W, H);
  if (!p.buf) {
    wctx.fillStyle = '#3a4258'; wctx.font = 12 * devicePixelRatio + 'px sans-serif'; wctx.textAlign = 'center';
    wctx.fillText('empty — record (●) or IMPORT', W / 2, H / 2);
    return;
  }
  const d = p.buf.getChannelData(0), step = Math.max(1, Math.floor(d.length / W));
  wctx.strokeStyle = '#5b8bd9'; wctx.lineWidth = 1; wctx.beginPath();
  for (let x = 0; x < W; x++) {
    let mn = 1, mx = -1;
    const base = x * step;
    for (let i = 0; i < step; i += Math.max(1, step >> 4)) { const v = d[base + i] || 0; if (v < mn) mn = v; if (v > mx) mx = v; }
    wctx.moveTo(x, H / 2 + mn * H * .48); wctx.lineTo(x, H / 2 + mx * H * .48 + 1);
  }
  wctx.stroke();
  // dim outside trim, draw handles
  wctx.fillStyle = 'rgba(8,10,16,.72)';
  wctx.fillRect(0, 0, p.start * W, H); wctx.fillRect(p.end * W, 0, W - p.end * W, H);
  for (const [pos, col] of [[p.start, '#3ddc97'], [p.end, '#ffb02e']]) {
    wctx.fillStyle = col;
    wctx.fillRect(pos * W - 1.5 * devicePixelRatio, 0, 3 * devicePixelRatio, H);
    wctx.beginPath(); wctx.arc(pos * W, H - 12 * devicePixelRatio, 8 * devicePixelRatio, 0, 7); wctx.fill();
  }
}
$('#waveBox').addEventListener('pointerdown', ev => {
  const p = S.pads[S.selPad]; if (!p.buf) return;
  const r = wave.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width;
  dragHandle = Math.abs(x - p.start) < Math.abs(x - p.end) ? 'start' : 'end';
  $('#waveBox').setPointerCapture(ev.pointerId);
  moveHandle(x);
});
$('#waveBox').addEventListener('pointermove', ev => {
  if (dragHandle === null || !ev.buttons) return;
  const r = wave.getBoundingClientRect();
  moveHandle((ev.clientX - r.left) / r.width);
});
$('#waveBox').addEventListener('pointerup', () => { dragHandle = null; dirty(); });
$('#waveBox').addEventListener('pointercancel', () => { dragHandle = null; });
function moveHandle(x) {
  const p = S.pads[S.selPad]; x = clamp(x, 0, 1);
  if (dragHandle === 'start') p.start = Math.min(x, p.end - .005);
  else p.end = Math.max(x, p.start + .005);
  drawWave();
}
/* filter slider is log-scaled: 0..100 → 200Hz..20kHz (100 = off) */
const sliderToCut = v => v >= 100 ? 20000 : Math.round(200 * Math.pow(100, v / 100));
const cutToSlider = c => c >= 19000 ? 100 : Math.round(Math.log(c / 200) / Math.log(100) * 100);
$('#cGain').oninput = e => { S.pads[S.selPad].gain = e.target.value / 100; $('#oGain').textContent = e.target.value + '%'; dirty(); };
$('#cPitch').oninput = e => { S.pads[S.selPad].semis = +e.target.value; $('#oPitch').textContent = e.target.value + ' st'; dirty(); };
$('#cFine').oninput = e => { S.pads[S.selPad].fine = +e.target.value; $('#oFine').textContent = e.target.value + ' ct'; dirty(); };
$('#cAtk').oninput = e => { S.pads[S.selPad].attack = +e.target.value; $('#oAtk').textContent = e.target.value + 'ms'; dirty(); };
$('#cRel').oninput = e => { S.pads[S.selPad].release = +e.target.value; $('#oRel').textContent = e.target.value + 'ms'; dirty(); };
$('#cCut').oninput = e => {
  const p = S.pads[S.selPad]; p.cutoff = sliderToCut(+e.target.value);
  $('#oCut').textContent = p.cutoff >= 19000 ? 'off' : (p.cutoff >= 1000 ? (p.cutoff / 1000).toFixed(1) + 'k' : Math.round(p.cutoff)); dirty();
};
$('#cRes').oninput = e => { const p = S.pads[S.selPad]; p.res = e.target.value / 10; $('#oRes').textContent = p.res.toFixed(1); dirty(); };
$('#bMono').onclick = () => { const p = S.pads[S.selPad]; p.mono = !p.mono; drawEdit(); dirty(); };
$('#bVelFilt').onclick = () => { const p = S.pads[S.selPad]; p.velFilt = !p.velFilt; drawEdit(); dirty(); };
$('#cPan').oninput = e => { const p = S.pads[S.selPad]; p.pan = e.target.value / 100; $('#oPan').textContent = p.pan === 0 ? 'C' : (p.pan < 0 ? 'L' : 'R') + Math.abs(e.target.value); dirty(); };
$('#bMode').onclick = () => { const p = S.pads[S.selPad]; p.mode = { oneshot: 'gate', gate: 'loop', loop: 'oneshot' }[p.mode]; drawEdit(); dirty(); };
$('#bChoke').onclick = () => { const p = S.pads[S.selPad]; p.choke = (p.choke + 1) % 5; drawEdit(); dirty(); };
$('#bReverse').onclick = () => {
  const p = S.pads[S.selPad]; if (!p.buf) return;
  for (let c = 0; c < p.buf.numberOfChannels; c++) p.buf.getChannelData(c).reverse();
  const s = p.start; p.start = 1 - p.end; p.end = 1 - s;
  drawWave(); dirty();
};
$('#bNorm').onclick = () => {
  const p = S.pads[S.selPad]; if (!p.buf) return;
  let peak = 0;
  for (let c = 0; c < p.buf.numberOfChannels; c++) { const d = p.buf.getChannelData(c); for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i])); }
  if (peak > 0.0001) { const k = .98 / peak; for (let c = 0; c < p.buf.numberOfChannels; c++) { const d = p.buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= k; } }
  drawWave(); dirty(); toast('Normalized');
};
$('#bCrop').onclick = () => {
  const p = S.pads[S.selPad]; if (!p.buf) return;
  const s = Math.floor(p.start * p.buf.length), e = Math.floor(p.end * p.buf.length);
  if (e - s < 64) return;
  const nb = ctx.createBuffer(p.buf.numberOfChannels, e - s, p.buf.sampleRate);
  for (let c = 0; c < p.buf.numberOfChannels; c++) nb.getChannelData(c).set(p.buf.getChannelData(c).slice(s, e));
  p.buf = nb; p.start = 0; p.end = 1;
  drawEdit(); dirty(); toast('Cropped');
};
$('#bImport').onclick = () => $('#fileIn').click();
$('#bCopy').onclick = () => {
  const p = S.pads[S.selPad]; if (!p.buf) { toast('Nothing to copy'); return; }
  S.clipboard = { ...p };
  toast('Copied ' + padLabel(S.selPad));
};
$('#bPaste').onclick = () => {
  if (!S.clipboard) { toast('Clipboard empty'); return; }
  const src = S.clipboard;
  const np = { ...src };
  if (src.buf) { // deep-copy so destructive edits (reverse/crop/normalize) stay per-pad
    np.buf = ctx.createBuffer(src.buf.numberOfChannels, src.buf.length, src.buf.sampleRate);
    for (let c = 0; c < src.buf.numberOfChannels; c++) np.buf.getChannelData(c).set(src.buf.getChannelData(c));
  }
  S.pads[S.selPad] = np;
  drawPads(); drawEdit(); dirty(); toast('Pasted → ' + padLabel(S.selPad));
};
$('#bClear').onclick = () => {
  stopPad(S.selPad);
  S.pads[S.selPad] = newPad();
  drawPads(); drawEdit(); dirty(); toast('Cleared ' + padLabel(S.selPad));
};
$('#bKeys').onclick = () => {
  S.keys = !S.keys;
  if (S.keys) S.sixteen = null;
  drawEdit(); drawPerf();
  toast(S.keys ? 'Pads now play ' + padLabel(S.selPad) + ' chromatically' : 'Pads back to normal');
};
$('#selScale').onchange = e => { S.scale = e.target.value; dirty(); };

/* ------------------------------------------------ UI: menu */
$('#btnMenu').onclick = () => { $('#menu').classList.add('on'); drawMenu(); };
$('#mGuide').onclick = () => { $('#menu').classList.remove('on'); $('#guide').classList.add('on'); };
$('#guideClose').onclick = () => $('#guide').classList.remove('on');
$('#mClose').onclick = () => $('#menu').classList.remove('on');
$('#menu').addEventListener('click', e => { if (e.target.id === 'menu') $('#menu').classList.remove('on'); });
async function drawMenu() {
  $('#projName').value = S.projName;
  $('#verLabel').textContent = VERSION + (window.GibbonBridge ? ' · android' : ' · web');
  const keys = await listProjects().catch(() => []);
  const el = $('#projList'); el.innerHTML = '';
  keys.forEach(k => {
    const row = document.createElement('div'); row.className = 'projItem';
    const b = document.createElement('button'); b.className = 'mbtn'; b.textContent = '▸ ' + k;
    b.onclick = async () => { if (await loadProject(k)) { $('#menu').classList.remove('on'); toast('Loaded ' + k); } };
    const d = document.createElement('button'); d.className = 'mbtn del'; d.textContent = '✕';
    d.onclick = async () => { await deleteProject(k); drawMenu(); };
    row.appendChild(b); row.appendChild(d); el.appendChild(row);
  });
  drawChain();
}
$('#projName').addEventListener('input', e => { S.projName = e.target.value.trim() || 'untitled'; });
$('#mSave').onclick = async () => { await ensureAudio(); await saveProject(S.projName); drawMenu(); toast('Saved "' + S.projName + '"'); };
$('#mNew').onclick = () => {
  stop();
  S.pads = []; for (let i = 0; i < NUM_PADS; i++) S.pads.push(newPad());
  S.patterns = []; for (let i = 0; i < NUM_PATTERNS; i++) S.patterns.push(newSeq());
  S.chain = []; S.solo.clear(); S.pattern = 0; S.selPad = 0; S.projName = 'untitled';
  drawAll(); $('#menu').classList.remove('on'); toast('New project');
};
$('#mExportLoop').onclick = () => { $('#menu').classList.remove('on'); renderPatterns([S.pattern], safeName(S.projName) + '-loop.wav'); };
$('#mExportSong').onclick = () => {
  if (!S.chain.length) { toast('Song is empty — tap sequences below first'); return; }
  $('#menu').classList.remove('on');
  renderPatterns(expandChain(), safeName(S.projName) + '-song.wav');
};
$('#mExportPad').onclick = () => { $('#menu').classList.remove('on'); exportPad(); };
$('#mResample').onclick = async () => { await ensureAudio(); $('#menu').classList.remove('on'); startResample(); };
$('#mPlaySong').onclick = async () => {
  if (!S.chain.length) { toast('Song is empty — tap sequences below first'); return; }
  if (S.playing) stop();
  $('#menu').classList.remove('on');
  await play(true);
};
function drawChain() {
  const row = $('#chainRow'); row.innerHTML = '';
  for (let i = 0; i < NUM_PATTERNS; i++) {
    const b = document.createElement('button'); b.className = 'patBtn'; b.textContent = 'S' + (i + 1);
    b.onclick = () => {
      const last = S.chain[S.chain.length - 1];
      if (last && last.seq === i) last.reps++;    // tapping the same seq again = more repeats
      else S.chain.push({ seq: i, reps: 1 });
      drawChain(); dirty();
    };
    row.appendChild(b);
  }
  $('#chainView').textContent = S.chain.length
    ? 'song: ' + S.chain.map(c => 'S' + (c.seq + 1) + (c.reps > 1 ? '×' + c.reps : '')).join(' → ')
    : 'song: (empty)';
}
$('#mChainClear').onclick = () => { S.chain = []; drawChain(); dirty(); };

/* ------------------------------------------------ misc */
let toastTimer = 0;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2200);
}
function drawAll() {
  drawTopbar(); drawPads(); drawPerf(); drawSeqTop(); drawRowChips(); drawSteps(); drawEdit(); drawFx();
  if ($('#page-mix').classList.contains('on')) drawMix();
  $('#swing').value = S.swing; $('#swingOut').textContent = S.swing + '%';
}
window.addEventListener('resize', drawWave);

/* boot: restore autosave on first interaction (audio ctx needs a gesture) */
let booted = false;
async function boot() {
  if (booted) return; booted = true;
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  try { await ensureAudio(); await loadProject('__auto'); await loadChopSource(); } catch (e) {}
  try { // first run: open the workflow guide once
    if (!localStorage.getItem('sst_seen')) { localStorage.setItem('sst_seen', '1'); $('#guide').classList.add('on'); }
  } catch (e) {}
}
document.addEventListener('pointerdown', boot, { once: true, capture: true });
document.addEventListener('pointerup', boot, { once: true, capture: true });
drawAll();

/* restore the tab you were on last time */
try {
  const last = localStorage.getItem('sst_tab');
  if (last && last !== 'pads') {
    const el = $$('.tab').find(x => x.dataset.page === last);
    if (el) el.click();
  }
} catch (e) {}

/* PWA: offline service worker — only on the hosted site, never inside the Android shell */
if ('serviceWorker' in navigator && location.hostname.endsWith('github.io')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

/* debug/console access (harmless in production, handy on-device) */
window.__g = {
  get S() { return S; }, get ctx() { return ctx; }, get C() { return C; },
  ensureAudio, triggerPad, drawPads, drawEdit, drawAll, renderPatterns, saveProject, loadProject, dirty,
  drawChop, autoSlice, auditionAt, saveChopSource, loadChopSource,
  insertEvent, liveTickNow, expandChain, migrateSeq, touchSeq, drawSteps, drawSeqTop, drawMix, drawPerf,
  get curTick() { return curTick; }, TC, PPQ, STEP_T, swingDelayTicks, seqTicks,
};
