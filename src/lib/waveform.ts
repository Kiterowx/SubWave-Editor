export interface WaveLevel {
  scale: number;
  pointMs: number;
  samplesPerPoint: number;
  points: number;
  peaks: number[];
}

export class Waveform {
  durationMs: number;
  amplitudeMax: number;
  levels: WaveLevel[];

  constructor(json: any) {
    this.levels = (json.levels || [])
      .map((l: any) => ({
        scale: l.scale,
        pointMs: l.pointMs,
        samplesPerPoint: l.samplesPerPoint,
        points: l.points,
        peaks: l.peaks,
      }))
      .sort((a: WaveLevel, b: WaveLevel) => a.pointMs - b.pointMs);
    this.amplitudeMax = json.amplitudeMax || 32767;
    const last = this.levels[0];
    this.durationMs = json.durationMs || (last ? last.points * last.pointMs : 0);
  }

  static isWaveformJson(json: any): boolean {
    return json && json.type === 'waveform' && Array.isArray(json.levels);
  }

  pickLevel(msPerPx: number): WaveLevel {
    let chosen = this.levels[0];
    for (const lvl of this.levels) {
      if (lvl.pointMs <= Math.max(msPerPx, 0.0001)) chosen = lvl;
      else break;
    }
    return chosen;
  }

  minMax(level: WaveLevel, aMs: number, bMs: number): [number, number] {
    const peaks = level.peaks;
    const n = level.points;
    let i0 = Math.floor(aMs / level.pointMs);
    let i1 = Math.floor(bMs / level.pointMs);
    if (i1 <= i0) i1 = i0 + 1;
    if (i0 < 0) i0 = 0;
    if (i1 > n) i1 = n;
    if (i0 >= n) return [0, 0];
    let mn = 32767;
    let mx = -32768;
    for (let i = i0; i < i1; i++) {
      const lo = peaks[i * 2];
      const hi = peaks[i * 2 + 1];
      if (lo < mn) mn = lo;
      if (hi > mx) mx = hi;
    }
    if (mn > mx) return [0, 0];
    return [mn, mx];
  }

  snapToEdge(tMs: number, windowMs = 250): number {
    const level = this.levels[0];
    if (!level) return tMs;
    const thr = this.amplitudeMax * 0.06;
    const pm = level.pointMs;
    const center = Math.round(tMs / pm);
    const span = Math.round(windowMs / pm);
    const amp = (i: number) => {
      if (i < 0 || i >= level.points) return 0;
      return Math.max(Math.abs(level.peaks[i * 2]), Math.abs(level.peaks[i * 2 + 1]));
    };
    let best = -1;
    let bestDist = Infinity;
    for (let d = 0; d <= span; d++) {
      for (const i of d === 0 ? [center] : [center - d, center + d]) {
        const prev = amp(i - 1);
        const cur = amp(i);
        if ((prev < thr && cur >= thr) || (prev >= thr && cur < thr)) {
          const dist = Math.abs(i - center);
          if (dist < bestDist) {
            bestDist = dist;
            best = i;
          }
        }
      }
      if (best !== -1) break;
    }
    return best === -1 ? tMs : best * pm;
  }
}
