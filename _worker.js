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
    
    // Handle API proxy requests
    if (url.pathname.startsWith('/api/')) {
      return handleApiProxy(request, url, env);
    }
    
    // Gate /newBrand.html (and /newBrand) behind a URL token
    if (url.pathname === '/newBrand.html' || url.pathname === '/newBrand') {
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
      notified INTEGER DEFAULT 0
    )
  `).run();

  // Migrate existing tables — D1 throws if column already exists, so catch silently
  try { await db.prepare('ALTER TABLE waiting_list ADD COLUMN email TEXT').run(); } catch(e) {}
  try { await db.prepare('ALTER TABLE waiting_list ADD COLUMN notified INTEGER DEFAULT 0').run(); } catch(e) {}

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

    // Delete old entries (older than 8 hours)
    const cutoff = Date.now() - (8 * 60 * 60 * 1000);
    await env.EDEN_DB.prepare(
      'DELETE FROM waiting_list WHERE timestamp < ?'
    ).bind(cutoff).run();

    // Get current list
    const results = await env.EDEN_DB.prepare(
      'SELECT name, email, timestamp FROM waiting_list WHERE location_id = ? ORDER BY timestamp ASC'
    ).bind(locationId).all();

    const list = results.results.map(row => ({
      name: row.name,
      email: row.email,
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
    const { locationId, name, email } = body;

    if (!locationId || !name) {
      return jsonResponse({ error: 'locationId and name required' }, 400);
    }

    const timestamp = Date.now();

    await env.EDEN_DB.prepare(`
      INSERT INTO waiting_list (location_id, name, email, timestamp, notified)
      VALUES (?, ?, ?, ?, 0)
    `).bind(locationId, name.trim(), (email || '').trim(), timestamp).run();

    // Get updated list
    const results = await env.EDEN_DB.prepare(
      'SELECT name, email, timestamp FROM waiting_list WHERE location_id = ? ORDER BY timestamp ASC'
    ).bind(locationId).all();

    const list = results.results.map(row => ({
      name: row.name,
      email: row.email,
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
      'SELECT name, email, timestamp FROM waiting_list WHERE location_id = ? ORDER BY timestamp ASC'
    ).bind(locationId).all();

    const list = results.results.map(row => ({
      name: row.name,
      email: row.email,
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

    // Find first un-notified entry that has an email address
    const entry = await env.EDEN_DB.prepare(
      `SELECT id, name, email FROM waiting_list
       WHERE location_id = ? AND notified = 0 AND email IS NOT NULL AND email != ''
       ORDER BY timestamp ASC LIMIT 1`
    ).bind(locationId).first();

    if (!entry) {
      return jsonResponse({ notified: false, reason: 'No un-notified entries with email' });
    }

    const sent = await sendEmail(env, {
      to: entry.email,
      name: entry.name,
      locationName: locationName || 'the office'
    });

    if (sent) {
      await env.EDEN_DB.prepare(
        'UPDATE waiting_list SET notified = 1 WHERE id = ?'
      ).bind(entry.id).run();
      return jsonResponse({ notified: true, name: entry.name });
    }

    return jsonResponse({ notified: false, reason: 'Email send failed' });
  } catch (error) {
    console.error('Waiting list notify error:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

async function sendEmail(env, { to, name, locationName }) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return false;

  const from = env.RESEND_FROM_EMAIL || 'noreply@optimizely.com';

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
        subject: 'A desk is now available!',
        html: `<p>Hi ${name},</p>
<p>A desk has just become available at <strong>${locationName}</strong>.</p>
<p>You're first on the waiting list — head in now to grab a spot.</p>
<br>
<p style="color:#666;font-size:12px;">Optimizely Desk Availability</p>`
      })
    });
    return res.ok;
  } catch (e) {
    console.error('Email send error:', e);
    return false;
  }
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
