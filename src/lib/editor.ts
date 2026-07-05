import { Waveform } from './waveform';
import {
  parseSubtitles,
  serializeSrt,
  serializeAss,
  srtSubsToAss,
  type Sub,
  type AssDoc,
} from './subtitles';
import { msToClock, parseTimeToMs } from './time';
import {
  CHRONO_CFG,
  parseKeyframesLog,
  lowerBound,
  buildEnvelope,
  detectVoice,
  makeItems,
  planPadding,
  applyItems,
  type Envelope,
} from './chrono';

const ROW_H = 110;
const ROW_MARGIN = 6;
const PER_ROW = ROW_H + ROW_MARGIN;
const RULER_H = 18;
const HANDLE_HIT = 7;
const MIN_DUR = 10;
const UNDO_MAX = 50;

const REGION_PAL = [
  { fill: 'rgba(255,196,0,0.10)', border: 'rgba(255,196,0,0.40)', handle: 'rgba(255,196,0,0.85)', label: '#caa84e' },
  { fill: 'rgba(255,110,80,0.14)', border: 'rgba(255,110,80,0.50)', handle: 'rgba(255,110,80,0.90)', label: '#e08a6e' },
  { fill: 'rgba(190,120,255,0.14)', border: 'rgba(190,120,255,0.50)', handle: 'rgba(190,120,255,0.90)', label: '#c39ae6' },
  { fill: 'rgba(80,220,220,0.12)', border: 'rgba(80,220,220,0.45)', handle: 'rgba(80,220,220,0.90)', label: '#67cfc6' },
];

const COL = {
  bg: '#0f141b',
  center: '#1f2937',
  wave: '#3f9cff',
  ruler: '#0a0e13',
  rulerText: '#5c6b7a',
  rulerTick: '#1b2430',
  regSel: 'rgba(64,224,160,0.20)',
  regSelBorder: 'rgba(64,224,160,0.95)',
  handleSel: '#40e0a0',
  labelSel: '#bdf5da',
  playhead: '#ff5470',
  keyframe: 'rgba(198,92,255,0.55)',
};

interface Row {
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  index: number;
}

interface Gesture {
  kind: 'handle' | 'pending';
  subId: number | null;
  edge?: 'start' | 'end';
  downX?: number;
  downY?: number;
  moved: boolean;
  t?: number;
}

export function initEditor() {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  const timelineEl = $('timeline') as HTMLDivElement;
  const emptyHint = $('empty-hint') as HTMLDivElement;
  const audio = $('audio') as HTMLAudioElement;

  const state = {
    waveform: null as Waveform | null,
    subs: [] as Sub[],
    format: 'srt' as 'srt' | 'ass',
    assDoc: null as AssDoc | null,
    baseName: 'subtitulos',
    selectedId: null as number | null,
    pxPerSec: 80,
    gain: 1.2,
    magnet: true,
    fastMode: false,
    fps: 23.976,
    kfFrames: null as number[] | null,
    kfMs: [] as number[],
    kfSet: new Set<number>(),
    playMs: 0,
    playing: false,
    playUntil: null as number | null,
    autoPlay: false,
    W: 800,
    msPerRow: 10000,
    rowCount: 0,
    rows: [] as Row[],
  };

  let envelope: Envelope | null = null;
  const colorOf = new Map<number, number>();
  const undoStack: { id: number; start: number; end: number }[][] = [];

  const byId = (id: number | null) => state.subs.find((s) => s.id === id) || null;
  const visibleRows = new Set<Row>();

  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        const row = (en.target as any).__row as Row;
        if (en.isIntersecting) {
          visibleRows.add(row);
          drawRow(row);
        } else {
          visibleRows.delete(row);
        }
      }
    },
    { root: null, rootMargin: '250px 0px' },
  );

  function durationMs(): number {
    let d = state.waveform ? state.waveform.durationMs : 0;
    for (const s of state.subs) if (s.end > d) d = s.end;
    return Math.max(d, 1000);
  }

  function hasContent(): boolean {
    return !!state.waveform || state.subs.length > 0;
  }

  function pushUndo() {
    undoStack.push(state.subs.map((s) => ({ id: s.id, start: s.start, end: s.end })));
    if (undoStack.length > UNDO_MAX) undoStack.shift();
  }

  function doUndo() {
    const snap = undoStack.pop();
    if (!snap) return;
    for (const rec of snap) {
      const sub = byId(rec.id);
      if (sub) {
        sub.start = rec.start;
        sub.end = rec.end;
      }
    }
    resortRefresh();
    updateInspector();
  }

  function computeOverlapColors() {
    colorOf.clear();
    const order = [...state.subs].sort((a, b) => a.start - b.start || a.end - b.end);
    const active: { end: number; color: number }[] = [];
    for (const s of order) {
      for (let i = active.length - 1; i >= 0; i--) if (active[i].end <= s.start) active.splice(i, 1);
      const used = new Set(active.map((a) => a.color));
      let c = 0;
      while (used.has(c)) c++;
      colorOf.set(s.id, c);
      active.push({ end: s.end, color: c });
    }
  }

  function relayout() {
    if (!hasContent()) {
      timelineEl.innerHTML = '';
      io.disconnect();
      visibleRows.clear();
      state.rows = [];
      emptyHint.style.display = '';
      return;
    }
    emptyHint.style.display = 'none';
    state.W = Math.max(320, timelineEl.clientWidth || 800);
    state.msPerRow = Math.max(500, state.W / (state.pxPerSec / 1000));
    state.rowCount = Math.max(1, Math.ceil(durationMs() / state.msPerRow));

    io.disconnect();
    visibleRows.clear();
    timelineEl.innerHTML = '';
    state.rows = [];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < state.rowCount; i++) {
      const el = document.createElement('div');
      el.className = 'wf-row';
      el.style.height = ROW_H + 'px';
      const cv = document.createElement('canvas');
      const row: Row = { el, canvas: cv, ctx: cv.getContext('2d')!, index: i };
      (el as any).__row = row;
      el.appendChild(cv);
      frag.appendChild(el);
      state.rows.push(row);
    }
    timelineEl.appendChild(frag);
    for (const row of state.rows) io.observe(row.el);
    for (let i = 0; i < Math.min(state.rows.length, 14); i++) drawRow(state.rows[i]);
  }

  const rowT0 = (i: number) => i * state.msPerRow;

  function drawRow(row: Row) {
    const W = state.W;
    const H = ROW_H;
    const cv = row.canvas;
    const nw = Math.round(W * dpr);
    const nh = Math.round(H * dpr);
    if (cv.width !== nw || cv.height !== nh) {
      cv.width = nw;
      cv.height = nh;
      cv.style.width = W + 'px';
      cv.style.height = H + 'px';
    }
    const ctx = row.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const t0 = rowT0(row.index);
    const t1 = t0 + state.msPerRow;
    const msPerPx = state.msPerRow / W;

    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, W, H);

    const wfTop = RULER_H;
    const wfH = H - RULER_H;
    const mid = wfTop + wfH / 2;

    ctx.strokeStyle = COL.center;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid + 0.5);
    ctx.lineTo(W, mid + 0.5);
    ctx.stroke();

    if (state.waveform) {
      const level = state.waveform.pickLevel(msPerPx);
      ctx.strokeStyle = COL.wave;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const half = (wfH / 2) * state.gain;
      for (let x = 0; x < W; x++) {
        const a = t0 + x * msPerPx;
        const b = a + msPerPx;
        const [mn, mx] = state.waveform.minMax(level, a, b);
        if (mn === 0 && mx === 0) continue;
        let y1 = mid - (mx / 32768) * half;
        let y2 = mid - (mn / 32768) * half;
        if (y1 < wfTop) y1 = wfTop;
        if (y2 > wfTop + wfH) y2 = wfTop + wfH;
        ctx.moveTo(x + 0.5, y1);
        ctx.lineTo(x + 0.5, y2);
      }
      ctx.stroke();
    }

    if (state.kfMs.length) {
      ctx.strokeStyle = COL.keyframe;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = lowerBound(state.kfMs, t0); i < state.kfMs.length; i++) {
        const t = state.kfMs[i];
        if (t > t1) break;
        const x = (t - t0) / msPerPx;
        ctx.moveTo(x + 0.5, wfTop);
        ctx.lineTo(x + 0.5, wfTop + wfH);
      }
      ctx.stroke();
    }

    const clampX = (x: number) => (x < 0 ? 0 : x > W ? W : x);
    for (const sub of state.subs) {
      if (sub.end < t0 || sub.start > t1) continue;
      const xs = clampX((sub.start - t0) / msPerPx);
      const xe = clampX((sub.end - t0) / msPerPx);
      const w = Math.max(1, xe - xs);
      const selected = sub.id === state.selectedId;
      const pal = REGION_PAL[(colorOf.get(sub.id) || 0) % REGION_PAL.length];
      ctx.fillStyle = selected ? COL.regSel : pal.fill;
      ctx.fillRect(xs, wfTop, w, wfH);
      ctx.strokeStyle = selected ? COL.regSelBorder : pal.border;
      ctx.lineWidth = selected ? 2 : 1;
      ctx.strokeRect(xs + 0.5, wfTop + 0.5, w - 1, wfH - 1);

      const handleCol = selected ? COL.handleSel : pal.handle;
      if (sub.start >= t0 && sub.start <= t1) drawHandle(ctx, xs, wfTop, wfH, handleCol);
      if (sub.end >= t0 && sub.end <= t1) drawHandle(ctx, xe, wfTop, wfH, handleCol);

      if (w > 28) {
        ctx.fillStyle = selected ? COL.labelSel : pal.label;
        ctx.font = '11px system-ui, sans-serif';
        ctx.textBaseline = 'top';
        ctx.save();
        ctx.beginPath();
        ctx.rect(xs + 3, wfTop + 2, w - 6, 14);
        ctx.clip();
        ctx.fillText(subLabel(sub), xs + 4, wfTop + 3);
        ctx.restore();
      }
    }

    drawRuler(ctx, W, t0, msPerPx);

    if (state.playMs >= t0 && state.playMs <= t1) {
      const x = (state.playMs - t0) / msPerPx;
      ctx.strokeStyle = COL.playhead;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, H);
      ctx.stroke();
    }
  }

  function drawHandle(ctx: CanvasRenderingContext2D, x: number, top: number, h: number, color: string) {
    ctx.fillStyle = color;
    ctx.fillRect(x - 1, top, 2, h);
    ctx.fillRect(x - 3, top, 6, 7);
    ctx.fillRect(x - 3, top + h - 7, 6, 7);
  }

  function niceStep(target: number): number {
    const steps = [100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000];
    for (const s of steps) if (s >= target) return s;
    return steps[steps.length - 1];
  }

  function drawRuler(ctx: CanvasRenderingContext2D, W: number, t0: number, msPerPx: number) {
    ctx.fillStyle = COL.ruler;
    ctx.fillRect(0, 0, W, RULER_H);
    const stepMs = niceStep(90 * msPerPx);
    const t1 = t0 + state.msPerRow;
    const first = Math.ceil(t0 / stepMs) * stepMs;
    ctx.strokeStyle = COL.rulerTick;
    ctx.fillStyle = COL.rulerText;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (let t = first; t <= t1; t += stepMs) {
      const x = (t - t0) / msPerPx;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, RULER_H);
      ctx.stroke();
      ctx.fillText(formatTick(t, stepMs), x + 3, RULER_H / 2 + 1);
    }
  }

  function formatTick(ms: number, stepMs: number): string {
    const s = Math.floor(ms / 1000);
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    if (stepMs < 1000) return (ms / 1000).toFixed(1) + 's';
    return `${mm}:${String(ss).padStart(2, '0')}`;
  }

  function subLabel(sub: Sub): string {
    const t = sub.text
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return t.slice(0, 60);
  }

  function redrawVisible() {
    for (const row of visibleRows) drawRow(row);
  }

  function locate(cx: number, cy: number) {
    const rect = timelineEl.getBoundingClientRect();
    const W = state.W;
    let x = cx - rect.left;
    if (x < 0) x = 0;
    if (x > W) x = W;
    let idx = Math.floor((cy - rect.top) / PER_ROW);
    if (idx < 0) idx = 0;
    if (idx >= state.rowCount) idx = state.rowCount - 1;
    const t0 = rowT0(idx);
    const msPerPx = state.msPerRow / W;
    const t = Math.min(durationMs(), Math.max(0, t0 + x * msPerPx));
    return { idx, x, t0, t1: t0 + state.msPerRow, msPerPx, t };
  }

  function magnetize(t: number): number {
    if (!state.magnet) return t;
    const msPerPx = state.msPerRow / state.W;
    const win = Math.min(250, Math.max(15, 10 * msPerPx));
    let best = t;
    let bestD = Infinity;
    if (state.kfMs.length) {
      const i = lowerBound(state.kfMs, t);
      for (const j of [i - 1, i]) {
        if (j >= 0 && j < state.kfMs.length) {
          const d = Math.abs(state.kfMs[j] - t);
          if (d <= win && d < bestD) {
            best = state.kfMs[j];
            bestD = d;
          }
        }
      }
    }
    if (state.waveform) {
      const v = state.waveform.snapToEdge(t, win);
      const d = Math.abs(v - t);
      if (v !== t && d <= win && d < bestD) {
        best = v;
        bestD = d;
      }
    }
    return best;
  }

  function hitTestHandle(loc: ReturnType<typeof locate>): { subId: number; edge: 'start' | 'end' } | null {
    const cands: { subId: number; edge: 'start' | 'end'; d: number; sel: boolean }[] = [];
    for (const sub of state.subs) {
      if (sub.start >= loc.t0 && sub.start <= loc.t1) {
        const d = Math.abs(loc.x - (sub.start - loc.t0) / loc.msPerPx);
        if (d <= HANDLE_HIT) cands.push({ subId: sub.id, edge: 'start', d, sel: sub.id === state.selectedId });
      }
      if (sub.end >= loc.t0 && sub.end <= loc.t1) {
        const d = Math.abs(loc.x - (sub.end - loc.t0) / loc.msPerPx);
        if (d <= HANDLE_HIT) cands.push({ subId: sub.id, edge: 'end', d, sel: sub.id === state.selectedId });
      }
    }
    if (!cands.length) return null;
    cands.sort((a, b) => (b.sel ? 1 : 0) - (a.sel ? 1 : 0) || a.d - b.d);
    return { subId: cands[0].subId, edge: cands[0].edge };
  }

  function subAtTime(t: number): Sub | null {
    let best: Sub | null = null;
    for (const s of state.subs) {
      if (t >= s.start && t <= s.end) {
        if (!best || s.end - s.start < best.end - best.start) best = s;
      }
    }
    return best;
  }

  let gesture: Gesture | null = null;

  function onPointerDown(e: PointerEvent) {
    if (!hasContent() || e.button !== 0) return;
    const loc = locate(e.clientX, e.clientY);
    if (state.fastMode) {
      const sub = byId(state.selectedId);
      if (!sub) {
        const s = subAtTime(loc.t);
        if (s) selectSub(s.id, true, true);
        return;
      }
      pushUndo();
      sub.start = Math.max(0, Math.min(magnetize(loc.t), sub.end - MIN_DUR));
      resortRefresh();
      updateInspector();
      e.preventDefault();
      return;
    }
    const h = hitTestHandle(loc);
    if (h) {
      pushUndo();
      gesture = { kind: 'handle', subId: h.subId, edge: h.edge, moved: false };
      selectSub(h.subId, false);
      timelineEl.style.cursor = 'ew-resize';
      e.preventDefault();
    } else {
      const s = subAtTime(loc.t);
      gesture = { kind: 'pending', subId: s ? s.id : null, downX: e.clientX, downY: e.clientY, moved: false, t: loc.t };
    }
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }

  function onPointerMove(e: PointerEvent) {
    if (!gesture) return;
    const loc = locate(e.clientX, e.clientY);
    if (gesture.kind === 'handle') {
      gesture.moved = true;
      const sub = byId(gesture.subId);
      if (!sub) return;
      const t = magnetize(loc.t);
      if (gesture.edge === 'start') sub.start = Math.max(0, Math.min(t, sub.end - MIN_DUR));
      else sub.end = Math.max(sub.start + MIN_DUR, t);
      updateInspectorTimes(sub);
      computeOverlapColors();
      redrawVisible();
    } else {
      if (Math.abs(e.clientX - gesture.downX!) + Math.abs(e.clientY - gesture.downY!) > 4) gesture.moved = true;
      gesture.t = loc.t;
    }
  }

  function onPointerUp() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    timelineEl.style.cursor = '';
    if (!gesture) return;
    if (gesture.kind === 'handle') {
      const sub = byId(gesture.subId);
      if (!gesture.moved) undoStack.pop();
      resortRefresh();
      if (sub) updateInspector();
    } else if (!gesture.moved) {
      const onSub = gesture.subId != null;
      if (onSub) selectSub(gesture.subId, true, true);
      if (!(onSub && state.autoPlay && !!audio.src)) seek(gesture.t!);
    }
    gesture = null;
  }

  function onContextMenu(e: MouseEvent) {
    if (!state.fastMode || !hasContent()) return;
    e.preventDefault();
    const sub = byId(state.selectedId);
    if (!sub) return;
    const loc = locate(e.clientX, e.clientY);
    pushUndo();
    sub.end = Math.max(sub.start + MIN_DUR, magnetize(loc.t));
    resortRefresh();
    updateInspector();
  }

  function selectSub(id: number | null, scrollList: boolean, triggerAuto = false) {
    state.selectedId = id;
    updateInspector();
    highlightList();
    redrawVisible();
    if (scrollList && id != null) {
      const item = listEl.querySelector(`[data-id="${id}"]`) as HTMLElement | null;
      if (item) scrollListItemIntoView(item);
    }
    if (triggerAuto && state.autoPlay && id != null) {
      const sub = byId(id);
      if (sub) playSegment(sub);
    }
  }

  function stepSub(dir: number) {
    if (!state.subs.length) return;
    const order = [...state.subs].sort((a, b) => a.start - b.start);
    let idx = order.findIndex((s) => s.id === state.selectedId);
    if (idx === -1) idx = dir > 0 ? -1 : order.length;
    idx = Math.max(0, Math.min(order.length - 1, idx + dir));
    const sub = order[idx];
    selectSub(sub.id, true, true);
    scrollToSub(sub);
  }

  function scrollToSub(sub: Sub) {
    const idx = Math.floor(sub.start / state.msPerRow);
    const row = state.rows[idx];
    if (row) row.el.scrollIntoView({ block: 'nearest' });
  }

  function updateInspector() {
    const sub = byId(state.selectedId);
    const insp = $('insp');
    const inspEmpty = $('insp-empty');
    if (!sub) {
      insp.style.display = 'none';
      inspEmpty.style.display = '';
      return;
    }
    insp.style.display = '';
    inspEmpty.style.display = 'none';
    const order = [...state.subs].sort((a, b) => a.start - b.start);
    ($('f-num') as HTMLElement).textContent = '#' + (order.indexOf(sub) + 1);
    ($('f-start') as HTMLInputElement).value = msToClock(sub.start);
    ($('f-end') as HTMLInputElement).value = msToClock(sub.end);
    ($('f-dur') as HTMLElement).textContent = (sub.end - sub.start) + ' ms';
    ($('f-text') as HTMLTextAreaElement).value = sub.text;
    ($('play-seg') as HTMLButtonElement).disabled = !audio.src;
  }

  function updateInspectorTimes(sub: Sub) {
    if (state.selectedId !== sub.id) return;
    ($('f-start') as HTMLInputElement).value = msToClock(sub.start);
    ($('f-end') as HTMLInputElement).value = msToClock(sub.end);
    ($('f-dur') as HTMLElement).textContent = (sub.end - sub.start) + ' ms';
  }

  const listEl = $('sub-list') as HTMLDivElement;

  function scrollListItemIntoView(item: HTMLElement) {
    const cRect = listEl.getBoundingClientRect();
    const iRect = item.getBoundingClientRect();
    if (iRect.top < cRect.top) listEl.scrollTop -= cRect.top - iRect.top;
    else if (iRect.bottom > cRect.bottom) listEl.scrollTop += iRect.bottom - cRect.bottom;
  }

  function rebuildList() {
    const order = [...state.subs].sort((a, b) => a.start - b.start);
    ($('sub-count') as HTMLElement).textContent = String(order.length);
    const frag = document.createDocumentFragment();
    order.forEach((sub, i) => {
      const item = document.createElement('button');
      item.className = 'sub-item';
      item.dataset.id = String(sub.id);
      if (sub.id === state.selectedId) item.classList.add('sel');
      item.innerHTML =
        `<span class="si-num">${i + 1}</span>` +
        `<span class="si-time">${msToClock(sub.start)} → ${msToClock(sub.end)}</span>` +
        `<span class="si-text"></span>`;
      (item.querySelector('.si-text') as HTMLElement).textContent = subLabel(sub) || '∅';
      item.addEventListener('click', () => selectSub(sub.id, false, true));
      frag.appendChild(item);
    });
    listEl.innerHTML = '';
    listEl.appendChild(frag);
  }

  function highlightList() {
    for (const el of Array.from(listEl.children) as HTMLElement[]) {
      el.classList.toggle('sel', el.dataset.id === String(state.selectedId));
    }
  }

  function resortRefresh() {
    state.subs.sort((a, b) => a.start - b.start);
    computeOverlapColors();
    const needed = Math.max(1, Math.ceil(durationMs() / state.msPerRow));
    if (needed !== state.rowCount) relayout();
    else redrawVisible();
    rebuildList();
  }

  function setPlayhead(t: number) {
    state.playMs = Math.max(0, Math.min(t, durationMs()));
    if (audio.src) audio.currentTime = state.playMs / 1000;
    updateTimeLabel();
    if (!state.playing) redrawVisible();
  }

  function seek(t: number) {
    state.playUntil = null;
    setPlayhead(t);
  }

  function playSegment(sub: Sub) {
    if (!audio.src) return;
    setPlayhead(sub.start);
    state.playUntil = sub.end;
    audio.play();
  }

  function updateTimeLabel() {
    ($('time-cur') as HTMLElement).textContent = msToClock(state.playMs);
    ($('time-dur') as HTMLElement).textContent = msToClock(durationMs());
  }

  function loop() {
    if (!state.playing) return;
    state.playMs = audio.currentTime * 1000;
    if (state.playUntil != null && state.playMs >= state.playUntil) {
      state.playMs = state.playUntil;
      state.playUntil = null;
      audio.pause();
      updateTimeLabel();
      redrawVisible();
      return;
    }
    updateTimeLabel();
    redrawVisible();
    requestAnimationFrame(loop);
  }

  function togglePlay() {
    if (!audio.src) return;
    if (state.playing) {
      audio.pause();
    } else {
      state.playUntil = null;
      audio.play();
    }
  }

  let toastTimer = 0;
  function toast(msg: string) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => el.classList.remove('show'), 4000);
  }

  async function loadWaveformFile(file: File) {
    try {
      const json = JSON.parse(await file.text());
      if (!Waveform.isWaveformJson(json)) {
        alert('El JSON no parece un waveform válido.');
        return;
      }
      state.waveform = new Waveform(json);
      envelope = null;
      state.playMs = 0;
      relayout();
      updateTimeLabel();
      ($('play') as HTMLButtonElement).blur();
    } catch (err) {
      alert('No se pudo leer el JSON: ' + err);
    }
  }

  async function loadSubFile(file: File) {
    try {
      const content = await file.text();
      const res = parseSubtitles(file.name, content);
      state.subs = res.subs.sort((a, b) => a.start - b.start);
      state.format = res.format;
      state.assDoc = res.assDoc;
      state.baseName = file.name.replace(/\.[^.]+$/, '') || 'subtitulos';
      state.selectedId = state.subs.length ? state.subs[0].id : null;
      undoStack.length = 0;
      computeOverlapColors();
      ($('fmt-badge') as HTMLElement).textContent = res.format.toUpperCase();
      ($('fmt-badge') as HTMLElement).style.display = '';
      rebuildList();
      relayout();
      updateInspector();
      updateTimeLabel();
      ($('export-srt') as HTMLButtonElement).disabled = false;
      ($('export-ass') as HTMLButtonElement).disabled = false;
    } catch (err) {
      alert('No se pudo leer el subtítulo: ' + err);
    }
  }

  async function loadKeyframesFile(file: File) {
    try {
      const frames = parseKeyframesLog(await file.text());
      if (!frames.length) {
        alert('No se encontraron keyframes en el archivo.');
        return;
      }
      state.kfFrames = frames;
      recomputeKf();
      toast(`${frames.length} keyframes cargados`);
    } catch (err) {
      alert('No se pudo leer el archivo de keyframes: ' + err);
    }
  }

  function recomputeKf() {
    if (!state.kfFrames) return;
    const ms = state.kfFrames.map((f) => Math.round((f * 1000) / state.fps));
    ms.sort((a, b) => a - b);
    state.kfMs = ms;
    state.kfSet = new Set(ms);
    const el = $('kf-count');
    el.textContent = ms.length + ' KF';
    el.style.display = '';
    redrawVisible();
  }

  function loadAudioFile(file: File) {
    const url = URL.createObjectURL(file);
    audio.src = url;
    ($('play') as HTMLButtonElement).disabled = false;
    ($('play-seg') as HTMLButtonElement).disabled = state.selectedId == null;
  }

  function chronoItems() {
    state.subs.sort((a, b) => a.start - b.start);
    return makeItems(state.subs);
  }

  function detectVoiceAll(items: ReturnType<typeof makeItems>): number {
    if (!envelope) envelope = buildEnvelope(state.waveform!);
    let matched = 0;
    for (const it of items) {
      const v = detectVoice(it.os, it.oe, envelope, CHRONO_CFG);
      if (v) {
        it.vs = v.vs;
        it.ve = v.ve;
        it.use = true;
        matched++;
      }
    }
    return matched;
  }

  function runRawTiming() {
    if (!state.subs.length) {
      toast('Carga subtítulos primero.');
      return;
    }
    if (!state.waveform) {
      toast('Raw necesita el waveform.');
      return;
    }
    pushUndo();
    const items = chronoItems();
    const matched = detectVoiceAll(items);
    if (!matched) {
      undoStack.pop();
      toast('No se detectó voz en ningún subtítulo.');
      return;
    }
    for (const it of items) {
      if (it.use) {
        it.s = it.vs;
        it.e = it.ve;
      }
    }
    applyItems(items);
    resortRefresh();
    updateInspector();
    toast(`Raw: ${matched}/${items.length} líneas pegadas a la voz`);
  }

  function runFullTiming() {
    if (!state.subs.length) {
      toast('Carga subtítulos primero.');
      return;
    }
    if (!state.waveform) {
      toast('Full necesita el waveform.');
      return;
    }
    pushUndo();
    const items = chronoItems();
    const matched = detectVoiceAll(items);
    if (!matched) {
      undoStack.pop();
      toast('No se detectó voz en ningún subtítulo.');
      return;
    }
    const stats = planPadding(items, state.kfMs, state.kfSet, CHRONO_CFG);
    applyItems(items);
    resortRefresh();
    updateInspector();
    toast(`Full: ${matched}/${items.length} líneas · ${stats.snaps} snaps KF · ${stats.joins} uniones`);
  }

  function runPostTiming() {
    if (!state.subs.length) {
      toast('Carga subtítulos primero.');
      return;
    }
    pushUndo();
    const items = chronoItems();
    for (const it of items) {
      it.vs = it.os;
      it.ve = it.oe;
      it.use = true;
    }
    const stats = planPadding(items, state.kfMs, state.kfSet, CHRONO_CFG);
    const changed = applyItems(items);
    resortRefresh();
    updateInspector();
    toast(`Post-timing: ${changed} líneas ajustadas · ${stats.snaps} snaps KF · ${stats.joins} uniones`);
  }

  function download(name: string, content: string) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function assTextToPlain(t: string): string {
    return t
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N/gi, '\n')
      .replace(/\\h/gi, ' ');
  }

  function exportSrt() {
    const subs =
      state.format === 'ass'
        ? state.subs.map((s) => ({ ...s, text: assTextToPlain(s.text) }))
        : state.subs;
    download(state.baseName + '_edit.srt', serializeSrt(subs));
  }

  function exportAss() {
    const content = state.assDoc ? serializeAss(state.assDoc, state.subs) : srtSubsToAss(state.subs);
    download(state.baseName + '_edit.ass', content);
  }

  timelineEl.addEventListener('pointerdown', onPointerDown);
  timelineEl.addEventListener('contextmenu', onContextMenu);

  $('wf-file').addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) loadWaveformFile(f);
  });
  $('sub-file').addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) loadSubFile(f);
  });
  $('kf-file').addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) loadKeyframesFile(f);
  });
  $('audio-file').addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) loadAudioFile(f);
  });

  const zoom = $('zoom') as HTMLInputElement;
  zoom.addEventListener('input', () => {
    state.pxPerSec = Number(zoom.value);
    ($('zoom-val') as HTMLElement).textContent = state.pxPerSec + ' px/s';
    if (hasContent()) relayout();
  });
  const gain = $('gain') as HTMLInputElement;
  gain.addEventListener('input', () => {
    state.gain = Number(gain.value);
    redrawVisible();
  });
  const magnet = $('magnet') as HTMLInputElement;
  magnet.addEventListener('change', () => {
    state.magnet = magnet.checked;
  });
  const fast = $('fast') as HTMLInputElement;
  fast.addEventListener('change', () => {
    state.fastMode = fast.checked;
    timelineEl.classList.toggle('fast', state.fastMode);
  });
  const fpsInput = $('kf-fps') as HTMLInputElement;
  fpsInput.addEventListener('change', () => {
    const v = Number(fpsInput.value);
    if (!Number.isFinite(v) || v <= 0) {
      fpsInput.value = String(state.fps);
      return;
    }
    state.fps = v;
    recomputeKf();
  });

  $('raw-timing').addEventListener('click', runRawTiming);
  $('post-timing').addEventListener('click', runPostTiming);
  $('full-timing').addEventListener('click', runFullTiming);

  $('play').addEventListener('click', togglePlay);
  const autoplay = $('autoplay') as HTMLInputElement;
  autoplay.addEventListener('change', () => {
    state.autoPlay = autoplay.checked;
  });
  $('play-seg').addEventListener('click', () => {
    const sub = byId(state.selectedId);
    if (sub) playSegment(sub);
  });
  audio.addEventListener('play', () => {
    state.playing = true;
    ($('play') as HTMLElement).textContent = '❚❚';
    requestAnimationFrame(loop);
  });
  audio.addEventListener('pause', () => {
    state.playing = false;
    ($('play') as HTMLElement).textContent = '▶';
    redrawVisible();
  });
  audio.addEventListener('ended', () => {
    state.playing = false;
    ($('play') as HTMLElement).textContent = '▶';
    state.playUntil = null;
  });
  audio.addEventListener('timeupdate', () => {
    if (state.playUntil != null && audio.currentTime * 1000 >= state.playUntil) {
      state.playMs = state.playUntil;
      state.playUntil = null;
      audio.pause();
      updateTimeLabel();
      redrawVisible();
    }
  });

  const fStart = $('f-start') as HTMLInputElement;
  const fEnd = $('f-end') as HTMLInputElement;
  const fText = $('f-text') as HTMLTextAreaElement;

  function applyStart() {
    const sub = byId(state.selectedId);
    if (!sub) return;
    const v = parseTimeToMs(fStart.value);
    if (v == null) {
      fStart.value = msToClock(sub.start);
      return;
    }
    pushUndo();
    sub.start = Math.max(0, Math.min(v, sub.end - MIN_DUR));
    resortRefresh();
    updateInspector();
  }
  function applyEnd() {
    const sub = byId(state.selectedId);
    if (!sub) return;
    const v = parseTimeToMs(fEnd.value);
    if (v == null) {
      fEnd.value = msToClock(sub.end);
      return;
    }
    pushUndo();
    sub.end = Math.max(sub.start + MIN_DUR, v);
    resortRefresh();
    updateInspector();
  }
  fStart.addEventListener('change', applyStart);
  fEnd.addEventListener('change', applyEnd);
  fText.addEventListener('input', () => {
    const sub = byId(state.selectedId);
    if (!sub) return;
    sub.text = fText.value;
    redrawVisible();
    const item = listEl.querySelector(`[data-id="${sub.id}"] .si-text`) as HTMLElement | null;
    if (item) item.textContent = subLabel(sub) || '∅';
  });

  $('set-start').addEventListener('click', () => {
    const sub = byId(state.selectedId);
    if (!sub) return;
    pushUndo();
    sub.start = Math.max(0, Math.min(state.playMs, sub.end - MIN_DUR));
    resortRefresh();
    updateInspector();
  });
  $('set-end').addEventListener('click', () => {
    const sub = byId(state.selectedId);
    if (!sub) return;
    pushUndo();
    sub.end = Math.max(sub.start + MIN_DUR, state.playMs);
    resortRefresh();
    updateInspector();
  });

  for (const btn of Array.from(document.querySelectorAll('.nudge')) as HTMLElement[]) {
    btn.addEventListener('click', () => {
      const sub = byId(state.selectedId);
      if (!sub) return;
      pushUndo();
      const edge = btn.dataset.edge as 'start' | 'end';
      const delta = Number(btn.dataset.delta);
      if (edge === 'start') sub.start = Math.max(0, Math.min(sub.start + delta, sub.end - MIN_DUR));
      else sub.end = Math.max(sub.start + MIN_DUR, sub.end + delta);
      resortRefresh();
      updateInspector();
    });
  }

  $('export-srt').addEventListener('click', exportSrt);
  $('export-ass').addEventListener('click', exportAss);

  window.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      doUndo();
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
      return;
    }
    if (e.key === 'Enter') {
      if (tag === 'BUTTON') return;
      e.preventDefault();
      stepSub(1);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      stepSub(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      stepSub(-1);
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      seek(state.playMs + (e.shiftKey ? 1000 : 100));
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      seek(state.playMs - (e.shiftKey ? 1000 : 100));
      return;
    }
  });

  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      if (hasContent()) relayout();
    });
  });

  ($('zoom-val') as HTMLElement).textContent = state.pxPerSec + ' px/s';
  updateTimeLabel();
}
