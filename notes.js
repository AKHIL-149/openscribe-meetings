// Import meeting notes from a file (.pdf, .docx, .md, .txt). Everything happens on this computer: the file is
// read from memory, turned into plain text, and never written to disk or sent anywhere.
import path from 'path';

export const NOTE_TYPES = ['.pdf', '.docx', '.md', '.markdown', '.txt'];
export const MAX_NOTE_BYTES = 25 * 1024 * 1024;
const MAX_CHARS = 400_000; // far more than any meeting; keeps the summary model's input and the vault small

const fail = (message) => Object.assign(new Error(message), { status: 400 });

async function pdfText(buf) {
  const { getDocumentProxy, extractText } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: false });
  return (Array.isArray(text) ? text : [text]).join('\n\n');
}

async function docxText(buf) {
  const mammoth = (await import('mammoth')).default;
  return (await mammoth.extractRawText({ buffer: buf })).value;
}

// Markdown stays readable as it is; only markup that would confuse the summary is removed.
function markdownText(s) {
  return s
    .replace(/^---\n[\s\S]*?\n---\n/, '') // front matter
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '- ')
    .replace(/`{3}[^\n]*\n?/g, '');
}

/** File bytes + name -> { text, type }. Throws a friendly error (status 400) for anything unsupported. */
export async function extractNotes(buf, filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (!NOTE_TYPES.includes(ext)) throw fail(`Unsupported file type “${ext || 'none'}”. Use .pdf, .docx, .md or .txt.`);
  if (!buf?.length) throw fail('The file is empty.');
  if (buf.length > MAX_NOTE_BYTES) throw fail('The file is larger than 25 MB.');
  let text;
  try {
    if (ext === '.pdf') {
      if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('not a PDF');
      text = await pdfText(buf);
    } else if (ext === '.docx') {
      if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('not a .docx (Word) file');
      text = await docxText(buf);
    } else {
      if (buf.includes(0)) throw new Error('this looks like a binary file, not text');
      text = buf.toString('utf8').replace(/^﻿/, '');
      if (ext !== '.txt') text = markdownText(text);
    }
  } catch (e) {
    throw fail(`Could not read this ${ext.slice(1).toUpperCase()} file: ${e.message}`);
  }
  text = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) {
    throw fail(ext === '.pdf'
      ? 'No text found in this PDF. It may be a scan (pictures of pages); the app cannot read those yet.'
      : 'No text found in this file.');
  }
  return { text: text.slice(0, MAX_CHARS), truncated: text.length > MAX_CHARS, type: ext.slice(1) };
}

// Words that start a "Label: text" line in notes but are not people.
const LABELS = new Set(['action', 'actions', 'action item', 'action items', 'agenda', 'attendees', 'date', 'decision', 'decisions',
  'discussion', 'follow up', 'follow-up', 'goal', 'goals', 'location', 'next steps', 'note', 'notes', 'owner', 'present',
  'question', 'questions', 'risk', 'risks', 'summary', 'task', 'tasks', 'time', 'title', 'todo', 'topic', 'topics', 'update', 'updates']);
const SPEAKER_RE = /^([A-Z][\p{L}.'’-]*(?:\s+[A-Z][\p{L}.'’-]*){0,3})\s*:\s+(\S.*)$/u;
const STAMP_RE = /^[[(]?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[\])]?\s*[-–—]?\s*/;
const clean = (raw) => raw.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();

/**
 * Turn notes into transcript-style lines so summaries, search, "Ask" and export all work on them.
 * "Priya: we agreed to ship Friday" keeps Priya as the speaker when the same name opens at least two lines
 * (so "Action: call Sam" is not mistaken for a person; one-off names count once the notes use that style); everything else is attributed to "Notes".
 * A leading [12:03] or 12:03 timestamp is honoured; otherwise lines are spaced a few seconds apart.
 */
export function notesToSegments(text) {
  const lines = text.split(/\n+/).map(clean).filter(Boolean);
  const seen = new Map();
  for (const l of lines) {
    const body = l.replace(STAMP_RE, '');
    const m = SPEAKER_RE.exec(body);
    if (m && m[1].length <= 40 && !LABELS.has(m[1].toLowerCase())) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  }
  // A name is a person if it opens 2+ lines; once the notes clearly use that style, one-off names (≤2 words) count too.
  const style = [...seen.values()].some((n) => n >= 2);
  const people = new Set([...seen].filter(([name, n]) => n >= 2 || (style && name.split(/\s+/).length <= 2)).map(([name]) => name));
  const out = [];
  let t = 0;
  for (let line of lines) {
    let start = null;
    const ts = STAMP_RE.exec(line);
    if (ts && ts[0].length < line.length) { start = Number(ts[1] || 0) * 3600 + Number(ts[2]) * 60 + Number(ts[3]); line = line.slice(ts[0].length); }
    let speaker = 'Notes';
    const sp = SPEAKER_RE.exec(line);
    if (sp && people.has(sp[1])) { speaker = sp[1]; line = sp[2]; }
    if (start != null) t = Math.max(t, start);
    out.push({ speaker, start: Math.round(t), dur: 3, text: line.slice(0, 2000), imported: true });
    t += 4;
  }
  return out;
}
