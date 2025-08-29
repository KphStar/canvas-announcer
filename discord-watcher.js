// discord-watcher.js
// Free-tier friendly: adds HTTP server, supports START_ISO (no disk needed).
// Posts new Canvas announcements (course 187787) to a Discord channel, with body text + link.

import 'dotenv/config';
import fs from 'fs';
import http from 'http';
import { Client, GatewayIntentBits } from 'discord.js';

const {
  CANVAS_BASE, CANVAS_TOKEN, CANVAS_COURSE_ID,
  DISCORD_TOKEN, DISCORD_CHANNEL_ID,
  POLL_INTERVAL = '600',
  START_ISO // optional seed to avoid reposts after restarts on free plan
} = process.env;

for (const k of ['CANVAS_BASE','CANVAS_TOKEN','CANVAS_COURSE_ID','DISCORD_TOKEN','DISCORD_CHANNEL_ID']) {
  if (!process.env[k] || !String(process.env[k]).trim()) {
    console.error(`Missing required env var: ${k}`);
    process.exit(1);
  }
}

/* ---------- CLI args ---------- */
// Usage:
//   node discord-watcher.js            # normal polling
//   node discord-watcher.js --replay 3 # post latest 3 now (ignores state, does not save)
const argv = process.argv.slice(2);
const args = new Map();
for (let i = 0; i < argv.length; i += 2) {
  const k = argv[i];
  const v = argv[i + 1];
  if (k?.startsWith('--')) args.set(k.slice(2), v ?? '1');
}
const replayCount = args.has('replay') ? Math.max(1, Number(args.get('replay'))) : 0;

/* ---------- state (in-memory; no disk for free plan) ---------- */
// For free web service: do NOT rely on disk persistence.
// We’ll keep an in-memory state so it survives within a single container lifetime.
// Use START_ISO to seed baseline on boot so we don’t repost after restarts.
const STATE_PATH = process.env.STATE_PATH || null; // if you later move to paid w/ disk, set /data/state.json
let state = { lastISO: START_ISO || null, seenIds: [] };

// If you DO mount a disk later, we’ll read/write it transparently.
function readState() {
  if (STATE_PATH) {
    try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
    catch { /* ignore; stick with START_ISO */ }
  }
}
function writeState() {
  if (STATE_PATH) {
    try { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); } catch {}
  }
}
function updateState(newISO, newIds) {
  if (newISO && (!state.lastISO || new Date(newISO) > new Date(state.lastISO))) state.lastISO = newISO;
  const set = new Set([...(state.seenIds || []), ...newIds]);
  state.seenIds = Array.from(set).slice(-500);
  writeState();
}
readState();

/* ---------- Canvas helpers ---------- */
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
 * Global endpoint supports start_date → good for polling.
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

/* ---------- Discord ---------- */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function buildDiscordMessage(a) {
  const when = a.ts ? new Date(a.ts).toISOString().replace('T',' ').replace('Z',' UTC') : 'unknown time';
  const header = `**${a.title}**\nPosted: ${when} by ${a.author}\n\n`;
  const linkLine = `\n\n<${a.url}>`;
  const MAX = 2000;
  const maxBody = Math.max(0, MAX - header.length - linkLine.length);
  const body = a.message.length > maxBody ? (a.message.slice(0, maxBody - 1) + '…') : a.message;
  return header + body + linkLine;
}

async function postToDiscord(items) {
  if (!items.length) return;
  const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
  for (const a of items.slice().reverse()) {
    await channel.send(buildDiscordMessage(a));
  }
}

/* ---------- Modes ---------- */
async function replayLatest(n) {
  console.log(`[replay] fetching latest ${n} announcements…`);
  const list = await fetchSince(null, Math.max(n, 50));
  const slice = list.slice(0, n);
  console.log(`[replay] will post ${slice.length} items`);
  await postToDiscord(slice);
  console.log('[replay] done (state not modified).');
}

async function pollOnce() {
  const since = state.lastISO || new Date(Date.now() - 7*24*3600*1000).toISOString(); // last 7 days default
  const seen = new Set(state.seenIds || []);

  console.log(`[poll] since=${since}`);
  const list = await fetchSince(since, 50);
  console.log(`[poll] fetched ${list.length} announcements (newest ts=${list[0]?.ts || 'none'})`);

  const newer = list.filter(a =>
    (!state.lastISO || (a.ts && new Date(a.ts) > new Date(state.lastISO))) ||
    !seen.has(a.id)
  );
  console.log(`[poll] will post ${newer.length} new items`);

  if (newer.length) {
    await postToDiscord(newer);
    const newestTs = list[0]?.ts || state.lastISO;
    updateState(newestTs, newer.map(a => a.id));
    console.log(`[poll] state updated: lastISO=${newestTs}, +${newer.length} ids`);
  }
}

/* ---------- Boot ---------- */
client.once('clientReady', async () => {
  console.log(`Discord bot logged in as ${client.user.tag}`);

  // sanity-check channel
  try {
    const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
    if (!channel) throw new Error('Channel not found or not accessible');
    console.log(`Posting to #${channel?.name || DISCORD_CHANNEL_ID}`);
  } catch (e) {
    console.error('Failed to fetch DISCORD_CHANNEL_ID:', e.message || e);
    process.exit(1);
  }

  if (replayCount > 0) {
    await replayLatest(replayCount).catch(console.error);
    // exit after replay if running locally; on Render we keep the web server alive
  }

  await pollOnce().catch(console.error);
  setInterval(() => pollOnce().catch(console.error), Number(POLL_INTERVAL) * 1000);
});

client.login(DISCORD_TOKEN);

/* ---------- Tiny HTTP server for Render free web ---------- */
const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, lastISO: state.lastISO, seenCount: state.seenIds.length }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ProfBot OK\n');
}).listen(PORT, () => {
  console.log(`Health server listening on :${PORT}`);
});
// END OF FILE
