// discord-watcher.js
// Posts new Canvas announcements (course 187787) to a Discord channel,
// including the announcement text (plain) + link. Uses .env and state.json.

import 'dotenv/config';
import fs from 'fs';
import { Client, GatewayIntentBits } from 'discord.js';

const {
  CANVAS_BASE, CANVAS_TOKEN, CANVAS_COURSE_ID,
  DISCORD_TOKEN, DISCORD_CHANNEL_ID,
  POLL_INTERVAL = '600'
} = process.env;

for (const k of ['CANVAS_BASE','CANVAS_TOKEN','CANVAS_COURSE_ID','DISCORD_TOKEN','DISCORD_CHANNEL_ID']) {
  if (!process.env[k] || !String(process.env[k]).trim()) {
    console.error(`Missing required env var: ${k}`);
    process.exit(1);
  }
}

/* ---------- tiny persistence ---------- */
const STATE_PATH = './state.json';
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { lastISO: null, seenIds: [] }; }
}
function writeState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }
function updateState(newISO, newIds) {
  const s = readState();
  if (newISO && (!s.lastISO || new Date(newISO) > new Date(s.lastISO))) s.lastISO = newISO;
  const set = new Set([...(s.seenIds || []), ...newIds]);
  s.seenIds = Array.from(set).slice(-500); // cap to 500 ids
  writeState(s);
}

/* ---------- helpers shared with your fetcher ---------- */
function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',').map(s => s.trim())) {
    if (part.includes('rel="next"')) {
      const m = part.match(/<([^>]+)>/);
      if (m) return m[1];
    }
  }
  return null;
}

async function getAll(url) {
  const headers = { Authorization: `Bearer ${CANVAS_TOKEN}` };
  let out = [];
  let next = url;
  while (next) {
    const res = await fetch(next, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Canvas ${res.status} ${res.statusText}\n${body}`);
    }
    out = out.concat(await res.json());
    next = parseNextLink(res.headers.get('link'));
  }
  return out;
}

function htmlToText(html) {
  if (!html) return '';
  let t = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  const ents = { '&nbsp;':' ', '&amp;':'&', '&lt;':'<', '&gt;':'>', '&quot;':'"', '&#39;':"'" };
  t = t.replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, m => ents[m] || m);
  return t.split('\n').map(s => s.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normalize(ann) {
  const ts = ann.posted_at || ann.created_at || null;
  return {
    id: ann.id,
    ts,
    title: ann.title || '(no title)',
    author: ann.author?.display_name || ann.user_name || 'Unknown',
    url: ann.html_url || ann.url,
    message: htmlToText(ann.message || '')
  };
}

/**
 * Fetch announcements since a timestamp (if provided).
 * We use the global announcements endpoint because it supports start_date.
 */
async function fetchSince(iso = null, perPage = 50) {
  const u = new URL(`${CANVAS_BASE}/api/v1/announcements`);
  u.searchParams.append('context_codes[]', `course_${CANVAS_COURSE_ID}`);
  u.searchParams.append('per_page', String(perPage));
  if (iso) u.searchParams.append('start_date', iso);
  const raw = await getAll(u.toString());
  const list = raw.map(normalize);
  list.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0)); // newest → oldest
  return list;
}

/* ---------- Discord bot ---------- */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function buildDiscordMessage(a) {
  const when = a.ts ? new Date(a.ts).toISOString().replace('T',' ').replace('Z',' UTC') : 'unknown time';

  // keep under Discord 2000 char limit (reserve room for header + link)
  const header = `**${a.title}**\nPosted: ${when} by ${a.author}\n\n`;
  const linkLine = `\n\n<${a.url}>`;
  const MAX = 2000;
  const maxBody = Math.max(0, MAX - header.length - linkLine.length);
  const body = a.message.length > maxBody ? (a.message.slice(0, maxBody - 1) + '…') : a.message;

  return header + body + linkLine;
}

async function announceNewOnDiscord(items) {
  if (!items.length) return;
  const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
  // Post oldest → newest so chat reads top-to-bottom chronologically
  for (const a of items.slice().reverse()) {
    await channel.send(buildDiscordMessage(a));
  }
}

async function pollOnce() {
  const state = readState();
  const since = state.lastISO || new Date(Date.now() - 7*24*3600*1000).toISOString(); // default: last 7 days
  const seen = new Set(state.seenIds || []);

  const list = await fetchSince(since, 50); // pagination handled in getAll
  // Filter to only *new* items based on timestamp OR unseen id
  const newer = list.filter(a =>
    (!state.lastISO || (a.ts && new Date(a.ts) > new Date(state.lastISO))) ||
    !seen.has(a.id)
  );

  if (newer.length === 0) return;

  await announceNewOnDiscord(newer);

  const newestTs = list[0]?.ts || state.lastISO;
  updateState(newestTs, newer.map(a => a.id));
}

// Use the non-deprecated ready name in v14+ to avoid warnings in future v15
client.once('clientReady', async () => {
  console.log(`Discord bot logged in as ${client.user.tag}`);
  // initial poll
  pollOnce().catch(console.error);
  // interval poll
  setInterval(() => pollOnce().catch(console.error), Number(POLL_INTERVAL) * 1000);
});

client.login(DISCORD_TOKEN);
// End of file