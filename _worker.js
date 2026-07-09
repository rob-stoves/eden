export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduledNotifications(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Handle waiting list endpoints
    if (url.pathname === '/waitinglist/get') {
      return handleWaitingListGet(request, env);
    }
    if (url.pathname === '/waitinglist/add') {
      return handleWaitingListAdd(request, env);
    }
    if (url.pathname === '/waitinglist/remove') {
      return handleWaitingListRemove(request, env);
    }
    if (url.pathname === '/waitinglist/notify') {
      return handleWaitingListNotify(request, env);
    }
    if (url.pathname === '/waitinglist/unsubscribe') {
      return handleWaitingListUnsubscribe(request, env);
    }
    
    // Handle nickname endpoints
    if (url.pathname === '/nicknames/get') {
      return handleNicknamesGet(request, env);
    }
    if (url.pathname === '/nicknames/set') {
      return handleNicknamesSet(request, env);
    }
    if (url.pathname === '/nicknames/delete') {
      return handleNicknamesDelete(request, env);
    }
    
    // Server-side availability check for join page (uses EDEN_API_TOKEN env var)
    if (url.pathname === '/check-availability') {
      return handleCheckAvailability(request, url, env);
    }

    // Planner data: desks + 5 working days reservations, all fetched in parallel
    if (url.pathname === '/planner-data') {
      return handlePlannerData(request, url, env);
    }

    // Handle API proxy requests
    if (url.pathname.startsWith('/api/')) {
      return handleApiProxy(request, url, env);
    }
    
    // Gate index and join pages behind a URL token
    const gatedPaths = ['/', '/index.html', '/index', '/join', '/join.html', '/planner', '/planner.html'];
    if (gatedPaths.includes(url.pathname)) {
      const expected = env.DISPLAY_TOKEN;
      if (!expected) {
        return new Response('Display token not configured. Set DISPLAY_TOKEN in Cloudflare Pages environment variables.', {
          status: 503, headers: { 'Content-Type': 'text/plain' }
        });
      }
      const provided = url.searchParams.get('token');
      if (!provided || provided !== expected) {
        return new Response('Access denied. A valid ?token= is required.', {
          status: 401, headers: { 'Content-Type': 'text/plain' }
        });
      }
    }

    // For all other requests, serve static assets
    return env.ASSETS.fetch(request);
  }
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

// Initialize D1 tables if they don't exist
async function initDB(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS waiting_list (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      location_id TEXT,
      name TEXT,
      email TEXT,
      timestamp INTEGER,
      notified INTEGER DEFAULT 0,
      last_notified_at INTEGER,
      token TEXT,
      desired_date TEXT
    )
  `).run();

  // Migrate existing tables — D1 throws if column already exists, so catch silently
  try { await db.prepare('ALTER TABLE waiting_list ADD COLUMN email TEXT').run(); } catch(e) {}
  try { await db.prepare('ALTER TABLE waiting_list ADD COLUMN notified INTEGER DEFAULT 0').run(); } catch(e) {}
  try { await db.prepare('ALTER TABLE waiting_list ADD COLUMN token TEXT').run(); } catch(e) {}
  try { await db.prepare('ALTER TABLE waiting_list ADD COLUMN desired_date TEXT').run(); } catch(e) {}
  try { await db.prepare('ALTER TABLE waiting_list ADD COLUMN last_notified_at INTEGER').run(); } catch(e) {}
  try { await db.prepare('ALTER TABLE waiting_list ADD COLUMN location_name TEXT').run(); } catch(e) {}

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_waiting_list_location ON waiting_list(location_id)
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS nicknames (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT UNIQUE,
      nickname TEXT
    )
  `).run();
}

// Get waiting list for a location
async function handleWaitingListGet(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const url = new URL(request.url);
    const locationId = url.searchParams.get('locationId');
    
    if (!locationId) {
      return jsonResponse({ error: 'locationId required' }, 400);
    }

    if (!env.EDEN_DB) {
      return jsonResponse({ list: [], reason: 'D1 not configured' });
    }

    await initDB(env.EDEN_DB);

    // Get current list
    const results = await env.EDEN_DB.prepare(
      'SELECT name, email, desired_date, timestamp FROM waiting_list WHERE location_id = ? ORDER BY timestamp ASC'
    ).bind(locationId).all();

    const list = results.results.map(row => ({
      name: row.name,
      email: row.email,
      desired_date: row.desired_date,
      timestamp: row.timestamp
    }));

    return jsonResponse({ list });
  } catch (error) {
    console.error('Waiting list get error:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

// Add to waiting list
async function handleWaitingListAdd(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    if (!env.EDEN_DB) {
      return jsonResponse({ success: false, reason: 'D1 not configured' });
    }

    await initDB(env.EDEN_DB);

    const body = await request.json();
    const { locationId, name, email, desired_date, locationName } = body;

    if (!locationId || !name) {
      return jsonResponse({ error: 'locationId and name required' }, 400);
    }
    if (email && !/@optimizely\.com$/i.test(email)) {
      return jsonResponse({ error: 'Please use your @optimizely.com email address.' }, 400);
    }

    // Duplicate check: same email + date
    if (desired_date && email) {
      const emailDupe = await env.EDEN_DB.prepare(
        `SELECT id FROM waiting_list WHERE location_id = ? AND LOWER(email) = LOWER(?) AND desired_date = ? LIMIT 1`
      ).bind(locationId, email.trim(), desired_date).first();
      if (emailDupe) return jsonResponse({ error: `You're already on the waiting list for this date.` }, 409);
    }

    const timestamp = Date.now();
    const token = crypto.randomUUID();

    await env.EDEN_DB.prepare(`
      INSERT INTO waiting_list (location_id, name, email, timestamp, notified, token, desired_date, location_name)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?)
    `).bind(locationId, name.trim(), (email || '').trim(), timestamp, token, desired_date || null, (locationName || '').trim() || null).run();

    // Get updated list
    const results = await env.EDEN_DB.prepare(
      'SELECT name, email, desired_date, timestamp FROM waiting_list WHERE location_id = ? ORDER BY timestamp ASC'
    ).bind(locationId).all();

    const list = results.results.map(row => ({
      name: row.name,
      email: row.email,
      desired_date: row.desired_date,
      timestamp: row.timestamp
    }));

    return jsonResponse({ success: true, list });
  } catch (error) {
    console.error('Waiting list add error:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

// Remove from waiting list
async function handleWaitingListRemove(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    if (!env.EDEN_DB) {
      return jsonResponse({ success: false, reason: 'D1 not configured' });
    }

    await initDB(env.EDEN_DB);

    const body = await request.json();
    const { locationId, name, desired_date } = body;

    if (!locationId || !name) {
      return jsonResponse({ error: 'locationId and name required' }, 400);
    }

    // Delete by name and date (case-insensitive) — date scopes removal to avoid deleting future entries
    if (desired_date) {
      await env.EDEN_DB.prepare(`
        DELETE FROM waiting_list WHERE location_id = ? AND LOWER(name) = LOWER(?) AND desired_date = ?
      `).bind(locationId, name.trim(), desired_date).run();
    } else {
      await env.EDEN_DB.prepare(`
        DELETE FROM waiting_list WHERE location_id = ? AND LOWER(name) = LOWER(?)
      `).bind(locationId, name.trim()).run();
    }

    // Get updated list
    const results = await env.EDEN_DB.prepare(
      'SELECT name, email, desired_date, timestamp FROM waiting_list WHERE location_id = ? ORDER BY timestamp ASC'
    ).bind(locationId).all();

    const list = results.results.map(row => ({
      name: row.name,
      email: row.email,
      desired_date: row.desired_date,
      timestamp: row.timestamp
    }));

    return jsonResponse({ success: true, list });
  } catch (error) {
    console.error('Waiting list remove error:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

// Notify the first un-notified waiting list person if desks are available
async function handleWaitingListNotify(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    if (!env.EDEN_DB) {
      return jsonResponse({ notified: false, reason: 'D1 not configured' });
    }

    await initDB(env.EDEN_DB);

    const body = await request.json();
    const { locationId, locationName } = body;

    if (!locationId) {
      return jsonResponse({ error: 'locationId required' }, 400);
    }

    const { deskName, today } = body;

    const oneHourAgo = Date.now() - 3600000;

    // Find all entries eligible for notification: have email, for today (or no date), not notified in last hour
    const results = await env.EDEN_DB.prepare(
      `SELECT id, name, email, token FROM waiting_list
       WHERE location_id = ? AND email IS NOT NULL AND email != ''
         AND (desired_date IS NULL OR desired_date = '' OR desired_date = ?)
         AND (last_notified_at IS NULL OR last_notified_at < ?)
       ORDER BY timestamp ASC`
    ).bind(locationId, today || '', oneHourAgo).all();

    const entries = results.results;

    if (entries.length === 0) {
      return jsonResponse({ notified: false, reason: 'No eligible entries with email' });
    }

    const origin = new URL(request.url).origin;
    const now = Date.now();
    const notifiedNames = [];

    for (const entry of entries) {
      const otherNames = entries.filter(e => e.id !== entry.id).map(e => e.name);
      const unsubscribeUrl = `${origin}/waitinglist/unsubscribe?token=${entry.token}`;

      const sent = await sendEmail(env, {
        to: entry.email,
        name: entry.name,
        locationName: locationName || 'the office',
        locationId,
        deskName: deskName || null,
        otherNames,
        unsubscribeUrl,
        today
      });

      if (sent) {
        await env.EDEN_DB.prepare(
          'UPDATE waiting_list SET notified = 1, last_notified_at = ? WHERE id = ?'
        ).bind(now, entry.id).run();
        notifiedNames.push(entry.name);
      }
    }

    if (notifiedNames.length > 0) {
      return jsonResponse({ notified: true, names: notifiedNames });
    }

    return jsonResponse({ notified: false, reason: 'All email sends failed' });
  } catch (error) {
    console.error('Waiting list notify error:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

async function sendEmail(env, { to, name, locationName, locationId, deskName, otherNames, unsubscribeUrl, today }) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return false;

  const from = env.RESEND_FROM_EMAIL || 'noreply@optimizely.com';
  const deskLine = deskName
    ? `<p>Desk ${deskName} is free — head in to Eden now to grab it.</p>`
    : `<p>Head in to Eden now to grab a spot.</p>`;

  let raceLine = '';
  if (otherNames && otherNames.length > 0) {
    const nameList = otherNames.length === 1
      ? otherNames[0]
      : otherNames.slice(0, -1).join(', ') + ' and ' + otherNames[otherNames.length - 1];
    raceLine = `<p>This email has also been sent to <strong>${nameList}</strong> — it's a race to book a desk!</p>`;
  }

  // Build Eden booking URL — date param is MM-DD-YYYY
  let edenUrl = 'https://optimizely.team.eden.io/reservations/desk';
  if (today) {
    const [year, month, day] = today.split('-');
    const edenDate = `${month}-${day}-${year}`;
    edenUrl += `?allDay=true&date=${edenDate}`;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: deskName ? `Desk ${deskName} is free at ${locationName}!` : `A desk is free at ${locationName}!`,
        html: `<p>Hi ${name},</p>
<p>Good news — a desk has just become available at ${locationName}.</p>
${deskLine}
${raceLine}
<p><strong>What to do next:</strong></p>
<ol>
  <li><a href="${edenUrl}">Log in to Eden</a> via Okta to book your desk</li>
  <li>If you continue to get this email, you may have entered your name differently to how it's stored in Eden — you can manually <a href="${unsubscribeUrl}">remove yourself from the waiting list</a></li>
</ol>
<p style="color:#999;font-size:12px;">(Hopefully if Eden update their API we can automatically book you a desk when it becomes available)</p>`
      })
    });
    return res.ok;
  } catch (e) {
    console.error('Email send error:', e);
    return false;
  }
}

// Remove from waiting list via one-click token link
async function handleWaitingListUnsubscribe(request, env) {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');

    if (!token) {
      return new Response('Invalid link.', { status: 400, headers: { 'Content-Type': 'text/plain' } });
    }

    if (!env.EDEN_DB) {
      return new Response('Service unavailable.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }

    await initDB(env.EDEN_DB);

    const entry = await env.EDEN_DB.prepare(
      'SELECT id, name, desired_date FROM waiting_list WHERE token = ?'
    ).bind(token).first();

    if (!entry) {
      return new Response(unsubscribePage('This link has already been used or has expired.'), {
        status: 200, headers: { 'Content-Type': 'text/html' }
      });
    }

    await env.EDEN_DB.prepare('DELETE FROM waiting_list WHERE token = ?').bind(token).run();

    const dateLabel = entry.desired_date
      ? (() => {
          const d = new Date(entry.desired_date + 'T12:00:00Z');
          const day = d.getDate();
          const suffix = day === 1 || day === 21 || day === 31 ? 'st' : day === 2 || day === 22 ? 'nd' : day === 3 || day === 23 ? 'rd' : 'th';
          return d.toLocaleDateString('en-GB', { weekday: 'long', month: 'long' }).replace(/(\w+), (\w+)/, `$1 the ${day}${suffix} $2`);
        })()
      : null;

    const msg = dateLabel
      ? `You've been removed from the waiting list for ${dateLabel}, ${entry.name}.`
      : `You've been removed from the waiting list, ${entry.name}.`;

    return new Response(unsubscribePage(msg), {
      status: 200, headers: { 'Content-Type': 'text/html' }
    });
  } catch (error) {
    console.error('Unsubscribe error:', error);
    return new Response('Something went wrong.', { status: 500, headers: { 'Content-Type': 'text/plain' } });
  }
}

function unsubscribePage(message) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Waiting List</title>
<style>
  body { font-family: 'Roboto', sans-serif; background: #252825; color: #d2dec2;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #2b2e2b; border: 1px solid #3a3e3a; border-radius: 12px;
          padding: 40px 48px; max-width: 420px; text-align: center; }
  h2 { color: #abff44; font-size: 22px; margin-bottom: 12px; }
  p  { color: #8a9e8a; font-size: 15px; line-height: 1.6; }
</style></head><body>
<div class="card">
  <h2>Waiting List</h2>
  <p>${message}</p>
</div>
</body></html>`;
}

// Get all nicknames
async function handleNicknamesGet(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    if (!env.EDEN_DB) {
      return jsonResponse({ nicknames: [], reason: 'D1 not configured' });
    }

    await initDB(env.EDEN_DB);

    const results = await env.EDEN_DB.prepare(
      'SELECT full_name, nickname FROM nicknames ORDER BY full_name ASC'
    ).all();
    
    const nicknames = {};
    results.results.forEach(row => {
      nicknames[row.full_name.toLowerCase()] = row.nickname;
    });

    return jsonResponse({ nicknames, list: results.results });
  } catch (error) {
    console.error('Nicknames get error:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

// Set a nickname
async function handleNicknamesSet(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    if (!env.EDEN_DB) {
      return jsonResponse({ success: false, reason: 'D1 not configured' });
    }

    await initDB(env.EDEN_DB);

    const body = await request.json();
    const { fullName, nickname } = body;
    
    if (!fullName || !nickname) {
      return jsonResponse({ error: 'fullName and nickname required' }, 400);
    }

    await env.EDEN_DB.prepare(`
      INSERT OR REPLACE INTO nicknames (full_name, nickname)
      VALUES (?, ?)
    `).bind(fullName.trim(), nickname.trim()).run();

    return jsonResponse({ success: true });
  } catch (error) {
    console.error('Nicknames set error:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

// Delete a nickname
async function handleNicknamesDelete(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    if (!env.EDEN_DB) {
      return jsonResponse({ success: false, reason: 'D1 not configured' });
    }

    await initDB(env.EDEN_DB);

    const body = await request.json();
    const { fullName } = body;
    
    if (!fullName) {
      return jsonResponse({ error: 'fullName required' }, 400);
    }

    await env.EDEN_DB.prepare(
      'DELETE FROM nicknames WHERE full_name = ?'
    ).bind(fullName.trim()).run();

    return jsonResponse({ success: true });
  } catch (error) {
    console.error('Nicknames delete error:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

function getWorkingDays(n) {
  const days = [];
  const d = new Date();
  while (days.length < n) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) {
      days.push(d.toISOString().slice(0, 10));
    }
    d.setDate(d.getDate() + 1);
  }
  return days;
}

async function handlePlannerData(request, url, env) {
  try {
  const locationId = url.searchParams.get('location');
  if (!locationId) return jsonResponse({ error: 'location required' }, 400);

  const apiToken = (env.EDEN_API_TOKEN || '').trim();
  if (!apiToken) return jsonResponse({ error: 'EDEN_API_TOKEN not configured' }, 503);
  // Match the proxy exactly: same headers the main board uses
  const headers = { 'Authorization': apiToken, 'Content-Type': 'application/json' };

  const dates = getWorkingDays(5);

  // Step 1: fetch London desks — same call as main board
  const desksRes = await fetch(`https://public-api.eden.io/locations?type=desks&parent_id=${encodeURIComponent(locationId)}`, { headers });
  const desksJson = await desksRes.json().catch(() => []);
  const desksRaw = Array.isArray(desksJson) ? desksJson : [];
  const deskIds = new Set(desksRaw.map(d => d.location_id).filter(Boolean));

  // Step 2: fetch each day sequentially (avoid rate limiting), days run in parallel
  // Peak concurrency = 5 (one page-1 per day), not 40
  const INACTIVE = new Set(['cancelled', 'finished', 'released']);

  async function fetchDay(date) {
    const all = [];
    for (let batchStart = 1; batchStart <= 200; batchStart += 4) {
      const pages = await Promise.all(
        [0, 1, 2, 3].map(j => fetch(`https://public-api.eden.io/cola_reservations?date=${date}&page=${batchStart + j}`, { headers })
          .then(r => r.json()).catch(() => []))
      );
      let hasMore = false;
      for (const data of pages) {
        const arr = Array.isArray(data) ? data : [];
        all.push(...arr);
        if (arr.length >= 25) hasMore = true;
      }
      if (!hasMore) break;
    }
    const reservations = all
      .filter(r => !INACTIVE.has(r.status) && deskIds.has(r.location?.location_id))
      .map(r => ({ deskId: r.location.location_id, deskName: (r.location.title || '').trim(), name: r.owner?.name || 'Unknown' }));
    return { date, reservations };
  }

  const days = await Promise.all(dates.map(fetchDay));

  const desks = desksRaw.map(d => ({ id: d.location_id, name: (d.title || '').trim() }));

  return jsonResponse({ desks, days, _debug: { deskApiCount: desksRaw.length, dayCounts: days.map(d => ({ date: d.date, matched: d.reservations.length })) } });
  } catch (e) {
    return jsonResponse({ error: `Worker exception: ${e.message}` }, 500);
  }
}

// ── Scheduled background notifications ───────────────────────────────────────
// Runs on a cron trigger (configure in Cloudflare Pages → Functions → Cron Triggers)
// Requires: EDEN_API_TOKEN, RESEND_API_KEY, SITE_URL env vars
async function handleScheduledNotifications(env) {
  if (!env.EDEN_DB || !env.EDEN_API_TOKEN) return;

  await initDB(env.EDEN_DB);

  const today = new Date().toISOString().slice(0, 10);
  const oneHourAgo = Date.now() - 3600000;
  const INACTIVE = new Set(['cancelled', 'finished', 'released']);
  const apiToken = env.EDEN_API_TOKEN.trim();
  const headers = { 'Authorization': apiToken, 'Content-Type': 'application/json' };
  const siteUrl = (env.SITE_URL || '').replace(/\/$/, '');

  // All unique (location_id, desired_date) pairs with eligible un-notified entries
  const pairResults = await env.EDEN_DB.prepare(`
    SELECT DISTINCT location_id, desired_date, location_name
    FROM waiting_list
    WHERE email IS NOT NULL AND email != ''
      AND desired_date >= ?
      AND (last_notified_at IS NULL OR last_notified_at < ?)
  `).bind(today, oneHourAgo).all();

  const pairs = pairResults.results;
  if (pairs.length === 0) return;

  // Fetch desk list once per unique location
  const locationIds = [...new Set(pairs.map(p => p.location_id))];
  const desksByLocation = {};

  for (const locationId of locationIds) {
    const res = await fetch(
      `https://public-api.eden.io/locations?type=desks&parent_id=${encodeURIComponent(locationId)}`,
      { headers }
    ).catch(() => null);
    if (!res || !res.ok) continue;
    const json = await res.json().catch(() => []);
    const all = Array.isArray(json) ? json : [];
    // Apply same name-length filter as the board (removes non-desk resources)
    const desks = all.filter(d => (d.title || '').length <= 3);
    desksByLocation[locationId] = {
      desks,
      deskIds: new Set(desks.map(d => d.location_id).filter(Boolean))
    };
  }

  const now = Date.now();

  for (const { location_id: locationId, desired_date: date, location_name: locationName } of pairs) {
    const { desks = [], deskIds = new Set() } = desksByLocation[locationId] || {};
    if (desks.length === 0) continue;

    // Fetch reservations for this date
    const allRes = [];
    for (let page = 1; page <= 10; page++) {
      const res = await fetch(
        `https://public-api.eden.io/cola_reservations?date=${date}&page=${page}`,
        { headers }
      ).catch(() => null);
      if (!res || !res.ok) break;
      const data = await res.json().catch(() => []);
      const arr = Array.isArray(data) ? data : [];
      allRes.push(...arr.filter(r => !INACTIVE.has(r.status) && deskIds.has(r.location?.location_id)));
      if (arr.length < 25) break;
    }

    const bookedIds = new Set(allRes.map(r => r.location?.location_id).filter(Boolean));
    const freeDesks = desks.filter(d => !bookedIds.has(d.location_id));
    if (freeDesks.length === 0) continue;

    const firstFreeDesk = freeDesks[0];

    // Fetch eligible entries for this location + date
    const entryResults = await env.EDEN_DB.prepare(`
      SELECT id, name, email, token
      FROM waiting_list
      WHERE location_id = ? AND desired_date = ?
        AND email IS NOT NULL AND email != ''
        AND (last_notified_at IS NULL OR last_notified_at < ?)
      ORDER BY timestamp ASC
    `).bind(locationId, date, oneHourAgo).all();

    const entries = entryResults.results;
    if (entries.length === 0) continue;

    for (const entry of entries) {
      const otherNames = entries.filter(e => e.id !== entry.id).map(e => e.name);
      const unsubscribeUrl = siteUrl
        ? `${siteUrl}/waitinglist/unsubscribe?token=${entry.token}`
        : null;

      const sent = await sendEmail(env, {
        to: entry.email,
        name: entry.name,
        locationName: locationName || 'the office',
        locationId,
        deskName: firstFreeDesk?.title || null,
        otherNames,
        unsubscribeUrl,
        today: date
      });

      if (sent) {
        await env.EDEN_DB.prepare(
          'UPDATE waiting_list SET notified = 1, last_notified_at = ? WHERE id = ?'
        ).bind(now, entry.id).run();
      }
    }
  }
}

async function handleCheckAvailability(request, url, env) {
  const locationId = url.searchParams.get('location');
  const date       = url.searchParams.get('date');

  if (!locationId || !date) {
    return jsonResponse({ error: 'location and date are required' }, 400);
  }

  const apiToken = env.EDEN_API_TOKEN;
  if (!apiToken) {
    return jsonResponse({ error: 'EDEN_API_TOKEN not configured' }, 503);
  }

  const headers = { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' };

  try {
    const [desksRes, resvRes] = await Promise.all([
      fetch(`https://public-api.eden.io/locations?type=desks&parent_id=${encodeURIComponent(locationId)}`, { headers }),
      fetch(`https://public-api.eden.io/cola_reservations?date=${encodeURIComponent(date)}&page=1`, { headers }),
    ]);

    if (!desksRes.ok || !resvRes.ok) {
      return jsonResponse({ error: 'Eden API error' }, 502);
    }

    const desksData = await desksRes.json();
    const resvData  = await resvRes.json();

    const desks = Array.isArray(desksData)       ? desksData
                : Array.isArray(desksData?.data) ? desksData.data : [];
    const reservations = Array.isArray(resvData)       ? resvData
                       : Array.isArray(resvData?.data) ? resvData.data : [];

    const bookedIds = new Set(reservations.map(r => r.location_id || r.locationId).filter(Boolean));
    const freeDesks = desks.filter(d => !bookedIds.has(d.id));

    return jsonResponse({ freeCount: freeDesks.length, totalDesks: desks.length });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

async function handleApiProxy(request, url, env) {
  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      }
    });
  }

  // Get the path after /api/
  const pathAfterApi = url.pathname.replace(/^\/api\/?/, '/');
  const queryString = url.search;
  
  // Build the Eden API URL
  const edenUrl = `https://public-api.eden.io${pathAfterApi}${queryString}`;
  
  console.log(`Proxying: ${request.method} ${edenUrl}`);

  try {
    // Forward the request to Eden API
    const edenResponse = await fetch(edenUrl, {
      method: request.method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': request.headers.get('Authorization') || '',
      },
      body: request.method !== 'GET' && request.method !== 'HEAD' 
        ? await request.text() 
        : undefined,
    });

    // Get response body
    const responseBody = await edenResponse.text();

    // Return response with CORS headers
    return new Response(responseBody, {
      status: edenResponse.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      }
    });
  } catch (error) {
    console.error('Proxy error:', error);
    return new Response(JSON.stringify({ error: 'Proxy error: ' + error.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      }
    });
  }
}
