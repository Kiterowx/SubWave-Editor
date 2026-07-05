import type { Sub } from './subtitles';
import type { Waveform } from './waveform';

export interface ChronoCfg {
  leadInMs: number;
  leadOutMs: number;
  maxLeadOutMs: number;
  maxLeadInMs: number;
  kfEndRangeMs: number;
  kfStartRangeMs: number;
  kfBackMs: number;
  durationFloorMs: number;
  smoothMs: number;
  fillGapMs: number;
  minIslandMs: number;
  outerSearchMs: number;
  histBins: number;
  minVoiceMs: number;
  edgeNearMs: number;
  spillMassRatio: number;
  spillGapFactor: number;
  stackEpsMs: number;
  keepMinOutMs: number;
  flashGapMs: number;
  capGraceMs: number;
  frameGraceMs: number;
}

export const CHRONO_CFG: ChronoCfg = {
  leadInMs: 120,
  leadOutMs: 420,
  maxLeadOutMs: 800,
  maxLeadInMs: 400,
  kfEndRangeMs: 800,
  kfStartRangeMs: 400,
  kfBackMs: 100,
  durationFloorMs: 500,
  smoothMs: 10,
  fillGapMs: 60,
  minIslandMs: 60,
  outerSearchMs: 0,
  histBins: 96,
  minVoiceMs: 50,
  edgeNearMs: 20,
  spillMassRatio: 0.3,
  spillGapFactor: 1,
  stackEpsMs: 40,
  keepMinOutMs: 200,
  flashGapMs: 250,
  capGraceMs: 120,
  frameGraceMs: 45,
};

export function parseKeyframesLog(content: string): number[] {
  const frames: number[] = [];
  let frame = -1;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const c = line.charCodeAt(0) | 32;
    if (c < 97 || c > 122) continue;
    frame++;
    if (c === 105) frames.push(frame);
  }
  return frames;
}

export function lowerBound(list: number[], value: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface Envelope {
  prefix: Float64Array;
  n: number;
  pointMs: number;
}

export function buildEnvelope(wf: Waveform): Envelope {
  const level = wf.levels[0];
  if (!level) return { prefix: new Float64Array(1), n: 0, pointMs: 1 };
  const n = level.points;
  const prefix = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) {
    const lo = Math.abs(level.peaks[(i - 1) * 2]);
    const hi = Math.abs(level.peaks[(i - 1) * 2 + 1]);
    prefix[i] = prefix[i - 1] + (lo > hi ? lo : hi);
  }
  return { prefix, n, pointMs: level.pointMs };
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

function smoothAt(env: Envelope, idx: number, lw: number, rw: number): number {
  let l = idx - lw;
  let r = idx + rw;
  if (l < 1) l = 1;
  if (r > env.n) r = env.n;
  return (env.prefix[r] - env.prefix[l - 1]) / (r - l + 1);
}

function percentile(values: number[], p: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const tmp = [...values].sort((a, b) => a - b);
  if (n === 1) return tmp[0];
  const pos = ((n - 1) * p) / 100;
  const lo = clamp(Math.floor(pos), 0, n - 1);
  const hi = clamp(Math.ceil(pos), 0, n - 1);
  if (lo === hi) return tmp[lo];
  const frac = pos - lo;
  return tmp[lo] * (1 - frac) + tmp[hi] * frac;
}

function otsuThreshold(values: number[], bins: number): number {
  const n = values.length;
  if (n === 0) return 0;
  bins = Math.max(16, bins);
  const lo = percentile(values, 1);
  const hi = percentile(values, 99);
  if (hi <= lo) {
    let sum = 0;
    for (const v of values) sum += v;
    return sum / n;
  }
  const hist = new Array<number>(bins).fill(0);
  const span = hi - lo;
  for (let v of values) {
    if (v < lo) v = lo;
    if (v > hi) v = hi;
    hist[clamp(Math.floor(((v - lo) / span) * (bins - 1)), 0, bins - 1)]++;
  }
  const centers = new Array<number>(bins);
  let total = 0;
  let sumTotal = 0;
  for (let i = 0; i < bins; i++) {
    centers[i] = lo + ((i + 0.5) * span) / bins;
    total += hist[i];
    sumTotal += hist[i] * centers[i];
  }
  if (total === 0) return (lo + hi) / 2;
  let wB = 0;
  let sumB = 0;
  let bestVar = -1;
  let bestThr = centers[0];
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    sumB += hist[i] * centers[i];
    const wF = total - wB;
    if (wB > 0 && wF > 0) {
      const diff = sumB / wB - (sumTotal - sumB) / wF;
      const between = wB * wF * diff * diff;
      if (between > bestVar) {
        bestVar = between;
        bestThr = centers[i];
      }
    }
  }
  return bestThr;
}

interface Run {
  v: boolean;
  a: number;
  b: number;
}

function buildRuns(mask: boolean[]): Run[] {
  const runs: Run[] = [];
  let i = 0;
  while (i < mask.length) {
    const v = mask[i];
    let j = i + 1;
    while (j < mask.length && mask[j] === v) j++;
    runs.push({ v, a: i, b: j - 1 });
    i = j;
  }
  return runs;
}

function morphMask(mask: boolean[], fillGap: number, minIsland: number) {
  let runs = buildRuns(mask);
  for (let r = 1; r < runs.length - 1; r++) {
    const run = runs[r];
    if (!run.v && run.b - run.a + 1 <= fillGap && runs[r - 1].v && runs[r + 1].v) {
      for (let i = run.a; i <= run.b; i++) mask[i] = true;
    }
  }
  runs = buildRuns(mask);
  for (const run of runs) {
    if (run.v && run.b - run.a + 1 < minIsland) {
      for (let i = run.a; i <= run.b; i++) mask[i] = false;
    }
  }
}

interface Comp {
  a: number;
  b: number;
  duration: number;
  mass: number;
}

function buildComponents(mask: boolean[], values: number[], threshold: number, L0: number, pointMs: number): Comp[] {
  const comps: Comp[] = [];
  for (const run of buildRuns(mask)) {
    if (!run.v) continue;
    let mass = 0;
    for (let i = run.a; i <= run.b; i++) {
      const excess = values[i] - threshold;
      if (excess > 0) mass += excess;
    }
    const aMs = (L0 + run.a) * pointMs;
    const bMs = (L0 + run.b + 1) * pointMs;
    comps.push({ a: aMs, b: bMs, duration: bMs - aMs, mass });
  }
  return comps;
}

function removeEdgeSpill(comps: Comp[], startMs: number, endMs: number, cfg: ChronoCfg): Comp[] {
  if (comps.length <= 1) return comps;
  let maxMass = 0;
  for (const c of comps) if (c.mass > maxMass) maxMass = c.mass;
  if (maxMass <= 0) return comps;
  while (comps.length > 1) {
    const first = comps[0];
    const gap = comps[1].a - first.b;
    if (
      first.a <= startMs + cfg.edgeNearMs &&
      gap > cfg.spillGapFactor * Math.max(1, first.duration) &&
      first.mass < cfg.spillMassRatio * maxMass
    ) {
      comps.shift();
    } else break;
  }
  while (comps.length > 1) {
    const last = comps[comps.length - 1];
    const gap = last.a - comps[comps.length - 2].b;
    if (
      last.b >= endMs - cfg.edgeNearMs &&
      gap > cfg.spillGapFactor * Math.max(1, last.duration) &&
      last.mass < cfg.spillMassRatio * maxMass
    ) {
      comps.pop();
    } else break;
  }
  return comps;
}

export interface VoiceMatch {
  vs: number;
  ve: number;
  weak: boolean;
}

export function detectVoice(osMs: number, oeMs: number, env: Envelope, cfg: ChronoCfg): VoiceMatch | null {
  const pm = env.pointMs;
  if (oeMs <= osMs || env.n === 0) return null;
  const searchStart = Math.max(0, osMs - cfg.outerSearchMs);
  const searchEnd = Math.min(env.n * pm, oeMs + cfg.outerSearchMs);
  if (searchEnd <= searchStart + 10) return null;
  let L0 = Math.floor(searchStart / pm);
  let R0 = Math.floor(searchEnd / pm);
  if (R0 > env.n) R0 = env.n;
  if (L0 < 0) L0 = 0;
  const len = R0 - L0;
  if (len <= 10) return null;
  const smoothPoints = Math.max(1, Math.round(cfg.smoothMs / pm));
  const lw = Math.floor((smoothPoints - 1) / 2);
  const rw = smoothPoints - 1 - lw;
  const values = new Array<number>(len);
  for (let j = 1; j <= len; j++) values[j - 1] = Math.log(1 + smoothAt(env, L0 + j, lw, rw));
  const threshold = otsuThreshold(values, cfg.histBins);
  const mask = values.map((v) => v >= threshold);
  morphMask(mask, Math.max(0, Math.round(cfg.fillGapMs / pm)), Math.max(1, Math.round(cfg.minIslandMs / pm)));
  let comps = buildComponents(mask, values, threshold, L0, pm);
  if (!comps.length) return null;
  comps = removeEdgeSpill(comps, osMs, oeMs, cfg);
  if (!comps.length) return null;
  const vs = clamp(comps[0].a, searchStart, searchEnd);
  const ve = clamp(comps[comps.length - 1].b, searchStart, searchEnd);
  if (ve - vs < cfg.minVoiceMs) return null;
  const weak = vs <= searchStart + 1 || ve >= searchEnd - 1;
  return { vs: Math.round(vs), ve: Math.round(ve), weak };
}

function kfIn(kfs: number[], lo: number, hi: number, target: number): number | null {
  if (!kfs.length || hi < lo) return null;
  let pos = lowerBound(kfs, lo);
  let best: number | null = null;
  let bestD = Infinity;
  while (pos < kfs.length) {
    const t = kfs[pos];
    if (t > hi) break;
    const d = Math.abs(t - target);
    if (d < bestD) {
      best = t;
      bestD = d;
    }
    pos++;
  }
  return best;
}

export interface ChronoItem {
  sub: Sub;
  os: number;
  oe: number;
  chars: number;
  use: boolean;
  vs: number;
  ve: number;
  s: number;
  e: number;
  sKf: boolean;
  eKf: boolean;
  joinedL: boolean;
  joinedR: boolean;
  vpos: number;
  flags: string[];
}

export function makeItems(subs: Sub[]): ChronoItem[] {
  return subs.map((sub) => {
    const visible = sub.text.replace(/\{[^}]*\}/g, '').replace(/\\[NnHh]/g, ' ');
    return {
      sub,
      os: sub.start,
      oe: sub.end,
      chars: visible.replace(/\s+/g, '').length,
      use: false,
      vs: sub.start,
      ve: sub.end,
      s: sub.start,
      e: sub.end,
      sKf: false,
      eKf: false,
      joinedL: false,
      joinedR: false,
      vpos: -1,
      flags: [],
    };
  });
}

function addFlag(it: ChronoItem, flag: string) {
  if (!it.flags.includes(flag)) it.flags.push(flag);
}

const overlapLen = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0);

export interface ChronoStats {
  snaps: number;
  joins: number;
}

export function planPadding(items: ChronoItem[], kfs: number[], kfset: Set<number>, cfg: ChronoCfg): ChronoStats {
  const stats: ChronoStats = { snaps: 0, joins: 0 };
  const vis: ChronoItem[] = [];
  const processed: ChronoItem[] = [];
  for (const it of items) {
    vis.push(it);
    it.vpos = vis.length - 1;
    if (it.use) processed.push(it);
  }
  const grace = cfg.frameGraceMs;
  const stacked = (a: ChronoItem, b: ChronoItem) => overlapLen(a.os, a.oe, b.os, b.oe) > cfg.stackEpsMs;

  for (const it of processed) {
    it.s = it.vs - cfg.leadInMs;
    it.e = it.ve + cfg.leadOutMs;
    it.sKf = false;
    it.eKf = false;
    it.joinedL = false;
    it.joinedR = false;
    const origStartKf = kfIn(kfs, it.os - grace, it.os + grace, it.os);
    const origEndKf = kfIn(kfs, it.oe - grace, it.oe + grace, it.oe);
    let ks = kfIn(kfs, it.vs - cfg.kfStartRangeMs, it.vs, it.vs);
    if (ks == null) ks = kfIn(kfs, it.vs + 1, Math.min(it.vs + cfg.kfBackMs, it.ve - 1), it.vs + 1);
    if (
      ks == null &&
      origStartKf != null &&
      origStartKf >= it.vs - cfg.kfStartRangeMs - 2 * grace &&
      origStartKf <= it.vs + cfg.kfBackMs
    ) {
      ks = origStartKf;
    }
    if (ks != null) {
      it.s = ks;
      it.sKf = true;
    }
    const elo = Math.max(it.ve - cfg.kfBackMs, it.vs + 1);
    let ke = kfIn(kfs, it.ve, it.ve + cfg.kfEndRangeMs, it.ve);
    if (ke == null && elo <= it.ve - 1) ke = kfIn(kfs, elo, it.ve - 1, it.ve);
    if (ke == null && origEndKf != null && origEndKf > it.vs && origEndKf <= it.ve + cfg.maxLeadOutMs + 2 * grace) {
      ke = origEndKf;
    }
    if (ke != null) {
      it.e = ke;
      it.eKf = true;
    }
    if (it.s < 0) it.s = 0;
  }

  const setBoundary = (a: ChronoItem, b: ChronoItem, t: number) => {
    t = Math.round(t);
    a.e = t;
    b.s = t;
    const on = kfset.has(t);
    a.eKf = on;
    b.sKf = on;
    a.joinedR = true;
    b.joinedL = true;
    stats.joins++;
  };

  const resolvePair = (a: ChronoItem, b: ChronoItem, blocked: boolean, origChained: boolean) => {
    if (stacked(a, b)) return;
    if (b.vs < a.ve) {
      if (a.e > b.s) {
        addFlag(a, 'OVERLAP');
        addFlag(b, 'OVERLAP');
      }
      return;
    }
    if (blocked) {
      if (a.e > b.s) {
        a.e = clamp(b.s, a.ve, a.e);
        a.eKf = kfset.has(a.e);
      }
      if (a.e > b.s) {
        addFlag(a, 'OVERLAP');
        addFlag(b, 'OVERLAP');
      }
      return;
    }
    const vaE = a.ve;
    const vbS = b.vs;
    const gap = b.s - a.e;
    if (gap === 0) {
      a.joinedR = true;
      b.joinedL = true;
      return;
    }
    if (gap < 0) {
      let boundary: number | null = null;
      if (a.eKf && a.e <= vbS + cfg.kfBackMs) boundary = a.e;
      else if (b.sKf && b.s >= vaE - cfg.kfBackMs) boundary = b.s;
      else {
        const r0 = Math.max(vaE - cfg.kfBackMs, Math.min(a.e, b.s));
        const r1 = Math.min(vbS + cfg.kfBackMs, Math.max(a.e, b.s));
        boundary = kfIn(kfs, r0, r1, clamp(vbS - cfg.leadInMs, r0, r1));
        if (boundary == null) {
          const cand = vbS - cfg.leadInMs;
          if (cand - vaE >= cfg.keepMinOutMs) boundary = cand;
          else boundary = vaE + ((vbS - vaE) * cfg.leadOutMs) / (cfg.leadOutMs + cfg.leadInMs);
          boundary = clamp(boundary, vaE, vbS);
        }
      }
      setBoundary(a, b, boundary);
      return;
    }
    const outRoom = Math.max(0, cfg.maxLeadOutMs - (a.e - vaE));
    const inRoom = Math.max(0, cfg.maxLeadInMs - (vbS - b.s));
    const joinable = gap <= outRoom + inRoom;
    const flashy = gap <= cfg.flashGapMs;
    const wanted = joinable || flashy || origChained;
    const graceMs = flashy || origChained ? cfg.capGraceMs : 0;
    let zoneKf: number | null = null;
    if (b.s - a.e > 2) zoneKf = kfIn(kfs, a.e + 1, b.s - 1, clamp(vbS - cfg.leadInMs, a.e + 1, b.s - 1));
    if (a.eKf && b.sKf) {
      if (flashy) {
        if (b.s - vaE <= cfg.maxLeadOutMs + cfg.capGraceMs) setBoundary(a, b, b.s);
        else if (vbS - a.e <= cfg.maxLeadInMs + cfg.capGraceMs) setBoundary(a, b, a.e);
      }
      return;
    }
    if (a.eKf) {
      if (wanted && zoneKf == null && vbS - a.e <= cfg.maxLeadInMs + graceMs) setBoundary(a, b, a.e);
      return;
    }
    if (b.sKf) {
      if (zoneKf != null && zoneKf - vaE <= cfg.maxLeadOutMs) {
        a.e = zoneKf;
        a.eKf = true;
      } else if (wanted && b.s - vaE <= cfg.maxLeadOutMs + graceMs) {
        setBoundary(a, b, b.s);
      }
      return;
    }
    if (zoneKf != null) {
      if (wanted && zoneKf - vaE <= cfg.maxLeadOutMs + graceMs && vbS - zoneKf <= cfg.maxLeadInMs + graceMs) {
        setBoundary(a, b, zoneKf);
      }
      return;
    }
    if (!wanted) return;
    if (b.s - vaE <= cfg.maxLeadOutMs + graceMs) setBoundary(a, b, b.s);
    else if (joinable) setBoundary(a, b, vaE + cfg.maxLeadOutMs);
    else if (flashy) setBoundary(a, b, clamp(b.s, vaE, vbS));
  };

  for (let i = 0; i < processed.length - 1; i++) {
    const a = processed[i];
    const b = processed[i + 1];
    let blocked = false;
    for (let k = a.vpos + 1; k <= b.vpos - 1; k++) {
      const m = vis[k];
      if (!m.use && m.oe > a.ve && m.os < b.vs) {
        blocked = true;
        break;
      }
    }
    const origGap = b.os - a.oe;
    const origChained = origGap <= grace && origGap >= -cfg.stackEpsMs;
    resolvePair(a, b, blocked, origChained);
  }

  for (const it of processed) {
    const p = it.vpos > 0 ? vis[it.vpos - 1] : undefined;
    if (p && !p.use && !stacked(p, it) && it.s < p.oe) {
      it.s = Math.min(Math.max(it.s, p.oe), it.vs);
      it.sKf = kfset.has(it.s);
    }
    const nx = vis[it.vpos + 1];
    if (nx && !nx.use && !stacked(it, nx) && it.e > nx.os) {
      it.e = Math.max(Math.min(it.e, nx.os), it.ve);
      it.eKf = kfset.has(it.e);
    }
  }

  for (let i = 0; i < processed.length; i++) {
    const a = processed[i];
    for (let j = i + 1; j <= Math.min(i + 3, processed.length - 1); j++) {
      const b = processed[j];
      if (!stacked(a, b) && a.e > b.s) {
        a.e = Math.max(b.s, a.ve);
        a.eKf = kfset.has(a.e);
        if (a.e > b.s) {
          addFlag(a, 'OVERLAP');
          addFlag(b, 'OVERLAP');
        }
      }
    }
  }

  for (const it of processed) {
    if (!it.eKf && !it.joinedR) {
      const z = kfIn(kfs, it.ve, it.ve + cfg.kfEndRangeMs, it.ve);
      if (z != null && z !== it.e) {
        const nx = vis[it.vpos + 1];
        let lim: number | null = null;
        if (nx && !stacked(it, nx)) lim = nx.use ? nx.s : nx.os;
        let ok = true;
        if (lim != null) {
          if (z > lim) ok = false;
          else if (z < lim && lim - z < cfg.flashGapMs) ok = false;
        }
        if (ok) {
          it.e = z;
          it.eKf = true;
        }
      }
    }
  }

  for (const it of processed) {
    if (it.chars > 0) {
      let short = cfg.durationFloorMs - (it.e - it.s);
      if (short > 0) {
        const pall = it.vpos > 0 ? vis[it.vpos - 1] : undefined;
        let leftLim = 0;
        if (pall && !stacked(pall, it)) leftLim = pall.use ? pall.e : pall.oe;
        const nall = vis[it.vpos + 1];
        let rightLim = Infinity;
        if (nall && !stacked(it, nall)) rightLim = nall.use ? nall.s : nall.os;
        if (!it.eKf) {
          const give = Math.min(short, Math.max(0, rightLim - it.e));
          it.e += give;
          short -= give;
        }
        if (short > 0 && !it.sKf) {
          const give = Math.min(short, Math.max(0, it.s - leftLim));
          it.s -= give;
          short -= give;
        }
        if (short > 0) addFlag(it, 'SHORT');
      }
    }
  }

  for (let i = 0; i < vis.length - 1; i++) {
    const a = vis[i];
    const b = vis[i + 1];
    if ((a.use || b.use) && b.os >= a.oe - cfg.stackEpsMs) {
      let ae = a.use ? a.e : a.oe;
      let bs = b.use ? b.s : b.os;
      if (ae > bs) {
        if (a.use) {
          a.e = Math.max(bs, a.ve);
          a.eKf = kfset.has(a.e);
          ae = a.e;
        }
        if (ae > bs && b.use) {
          b.s = Math.min(ae, b.vs);
          b.sKf = kfset.has(b.s);
          bs = b.s;
        }
        if (ae > bs) {
          addFlag(a, 'OVERLAP');
          addFlag(b, 'OVERLAP');
        }
      }
    }
  }

  for (const it of processed) {
    if (it.sKf) stats.snaps++;
    if (it.eKf) stats.snaps++;
  }
  return stats;
}

export function applyItems(items: ChronoItem[]): number {
  let changed = 0;
  for (const it of items) {
    if (!it.use) continue;
    const ns = Math.max(0, Math.round(it.s));
    const ne = Math.max(Math.round(it.e), ns + 10);
    if (ns !== it.sub.start || ne !== it.sub.end) changed++;
    it.sub.start = ns;
    it.sub.end = ne;
  }
  return changed;
}
