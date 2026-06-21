export default {
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
    const { locationId, name, email, desired_date } = body;

    if (!locationId || !name) {
      return jsonResponse({ error: 'locationId and name required' }, 400);
    }

    const timestamp = Date.now();
    const token = crypto.randomUUID();

    await env.EDEN_DB.prepare(`
      INSERT INTO waiting_list (location_id, name, email, timestamp, notified, token, desired_date)
      VALUES (?, ?, ?, ?, 0, ?, ?)
    `).bind(locationId, name.trim(), (email || '').trim(), timestamp, token, desired_date || null).run();

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
    const { locationId, name } = body;
    
    if (!locationId || !name) {
      return jsonResponse({ error: 'locationId and name required' }, 400);
    }

    // Delete by name (case-insensitive)
    await env.EDEN_DB.prepare(`
      DELETE FROM waiting_list WHERE location_id = ? AND LOWER(name) = LOWER(?)
    `).bind(locationId, name.trim()).run();

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
      'SELECT id, name FROM waiting_list WHERE token = ?'
    ).bind(token).first();

    if (!entry) {
      return new Response(unsubscribePage('This link has already been used or has expired.'), {
        status: 200, headers: { 'Content-Type': 'text/html' }
      });
    }

    await env.EDEN_DB.prepare('DELETE FROM waiting_list WHERE token = ?').bind(token).run();

    return new Response(unsubscribePage(`You've been removed from the waiting list, ${entry.name}.`), {
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

  const rawToken = env.EDEN_API_TOKEN || '';
  if (!rawToken) return jsonResponse({ error: 'EDEN_API_TOKEN not configured' }, 503);
  const apiToken = rawToken.replace(/^Bearer\s+/i, '');
  const headers = { 'Authorization': `Bearer ${apiToken}` };
  const dates = getWorkingDays(5);

  // Fetch desks + pages 1 & 2 of reservations for all 5 days — all in parallel
  const allFetches = [
    fetch(`https://public-api.eden.io/locations?type=desks&parent_id=${encodeURIComponent(locationId)}`, { headers }),
    ...dates.flatMap(date => [
      fetch(`https://public-api.eden.io/cola_reservations?date=${date}&page=1`, { headers }),
      fetch(`https://public-api.eden.io/cola_reservations?date=${date}&page=2`, { headers }),
    ]),
  ];

  const responses = await Promise.all(allFetches);

  // Check for API failure on the desks call — return full detail for diagnosis
  if (!responses[0].ok) {
    const body = await responses[0].text().catch(() => '');
    return jsonResponse({ error: `Eden API ${responses[0].status} fetching desks`, detail: body.slice(0, 500) }, 502);
  }

  const jsons = await Promise.all(responses.map(r => r.json().catch(() => [])));

  const desksRaw = jsons[0];
  // Return all desks unfiltered — client applies the name-length filter
  const allDesks = Array.isArray(desksRaw) ? desksRaw
                 : Array.isArray(desksRaw?.data) ? desksRaw.data
                 : Array.isArray(desksRaw?.locations) ? desksRaw.locations
                 : [];

  const desks = allDesks.map(d => ({ id: d.location_id, name: d.title || '' }));
  const deskIds = new Set(desks.map(d => d.id));
  const INACTIVE = new Set(['cancelled', 'finished', 'released']);

  const days = dates.map((date, i) => {
    const p1 = jsons[1 + i * 2];
    const p2 = jsons[2 + i * 2];
    const page1 = Array.isArray(p1) ? p1 : [];
    const page2 = page1.length === 25 && Array.isArray(p2) ? p2 : [];
    const all = [...page1, ...page2];

    const reservations = all
      .filter(r => {
        const deskId = r.location?.location_id;
        return deskIds.has(deskId) && !INACTIVE.has(r.status);
      })
      .map(r => ({
        deskId: r.location.location_id,
        name: r.owner?.name || 'Unknown',
      }));

    return { date, reservations };
  });

  return jsonResponse({ desks, days, _debug: { rawDeskCount: allDesks.length, deskSample: allDesks.slice(0, 2) } });
  } catch (e) {
    return jsonResponse({ error: `Worker exception: ${e.message}` }, 500);
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
