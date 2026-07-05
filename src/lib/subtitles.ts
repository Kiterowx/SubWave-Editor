import { msToSrt, msToAss, parseTimeToMs } from './time';

export interface Sub {
  id: number;
  start: number;
  end: number;
  text: string;
}

export interface AssEvent {
  lineIndex: number;
  kind: string;
  fields: string[];
  startCol: number;
  endCol: number;
  textCol: number;
  subId: number;
}

export interface AssDoc {
  lines: string[];
  events: AssEvent[];
}

export interface ParseResult {
  format: 'srt' | 'ass';
  subs: Sub[];
  assDoc: AssDoc | null;
}

export function detectFormat(name: string, content: string): 'srt' | 'ass' {
  const lower = name.toLowerCase();
  if (lower.endsWith('.ass') || lower.endsWith('.ssa')) return 'ass';
  if (lower.endsWith('.srt')) return 'srt';
  return /\[Script Info\]|\[V4\+? Styles\]|^Dialogue:/m.test(content) ? 'ass' : 'srt';
}

export function parseSubtitles(name: string, content: string): ParseResult {
  const format = detectFormat(name, content);
  return format === 'ass' ? parseAss(content) : parseSrt(content);
}

function parseSrt(content: string): ParseResult {
  const text = content.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = text.split(/\n{2,}/);
  const subs: Sub[] = [];
  let id = 0;
  for (const block of blocks) {
    const lines = block.split('\n').filter((l, i) => !(i === 0 && l.trim() === ''));
    if (!lines.length) continue;
    let timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx === -1) continue;
    const m = lines[timeIdx].match(/([\d:,\.]+)\s*-->\s*([\d:,\.]+)/);
    if (!m) continue;
    const start = parseTimeToMs(m[1]);
    const end = parseTimeToMs(m[2]);
    if (start == null || end == null) continue;
    const textLines = lines.slice(timeIdx + 1);
    subs.push({ id: id++, start, end, text: textLines.join('\n') });
  }
  subs.sort((a, b) => a.start - b.start);
  return { format: 'srt', subs, assDoc: null };
}

export function serializeSrt(subs: Sub[]): string {
  const ordered = [...subs].sort((a, b) => a.start - b.start);
  return ordered
    .map((s, i) => `${i + 1}\n${msToSrt(s.start)} --> ${msToSrt(s.end)}\n${s.text}`)
    .join('\n\n') + '\n';
}

function splitAssValue(value: string, columns: number): string[] {
  const out: string[] = [];
  let rest = value;
  for (let i = 0; i < columns - 1; i++) {
    const idx = rest.indexOf(',');
    if (idx === -1) {
      out.push(rest);
      rest = '';
    } else {
      out.push(rest.slice(0, idx));
      rest = rest.slice(idx + 1);
    }
  }
  out.push(rest);
  return out;
}

function parseAss(content: string): ParseResult {
  const text = content.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n');
  const events: AssEvent[] = [];
  const subs: Sub[] = [];
  let id = 0;

  let inEvents = false;
  let format: string[] | null = null;
  let startCol = 1, endCol = 2, textCol = 9;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      inEvents = /events/i.test(section[1]);
      format = null;
      continue;
    }
    if (!inEvents) continue;

    const fmtMatch = line.match(/^\s*Format\s*:\s*(.+)$/i);
    if (fmtMatch) {
      format = fmtMatch[1].split(',').map((s) => s.trim());
      startCol = format.findIndex((c) => /^start$/i.test(c));
      endCol = format.findIndex((c) => /^end$/i.test(c));
      textCol = format.findIndex((c) => /^text$/i.test(c));
      if (startCol === -1) startCol = 1;
      if (endCol === -1) endCol = 2;
      if (textCol === -1) textCol = (format.length || 10) - 1;
      continue;
    }

    const evMatch = line.match(/^\s*(Dialogue|Comment)\s*:\s*(.*)$/i);
    if (evMatch && format) {
      const kind = /dialogue/i.test(evMatch[1]) ? 'Dialogue' : 'Comment';
      const fields = splitAssValue(evMatch[2], format.length);
      const start = parseTimeToMs(fields[startCol] || '');
      const end = parseTimeToMs(fields[endCol] || '');
      if (start == null || end == null) continue;
      const subId = id++;
      events.push({ lineIndex: i, kind, fields, startCol, endCol, textCol, subId });
      subs.push({ id: subId, start, end, text: fields[textCol] || '' });
    }
  }

  return { format: 'ass', subs, assDoc: { lines, events } };
}

export function serializeAss(doc: AssDoc, subs: Sub[]): string {
  const byId = new Map(subs.map((s) => [s.id, s]));
  const lines = [...doc.lines];
  for (const ev of doc.events) {
    const sub = byId.get(ev.subId);
    if (!sub) continue;
    const fields = [...ev.fields];
    fields[ev.startCol] = msToAss(sub.start);
    fields[ev.endCol] = msToAss(sub.end);
    fields[ev.textCol] = sub.text;
    lines[ev.lineIndex] = `${ev.kind}: ${fields.join(',')}`;
  }
  return lines.join('\n');
}

export function srtSubsToAss(subs: Sub[]): string {
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,10,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const ordered = [...subs].sort((a, b) => a.start - b.start);
  const body = ordered.map(
    (s) => `Dialogue: 0,${msToAss(s.start)},${msToAss(s.end)},Default,,0,0,0,,${s.text.replace(/\n/g, '\\N')}`,
  );
  return [...header, ...body].join('\n') + '\n';
}
