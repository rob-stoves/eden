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
      timestamp INTEGER
    )
  `).run();
  
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
      'SELECT name, timestamp FROM waiting_list WHERE location_id = ? ORDER BY timestamp ASC'
    ).bind(locationId).all();
    
    const list = results.results.map(row => ({
      name: row.name,
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
    const { locationId, name } = body;
    
    if (!locationId || !name) {
      return jsonResponse({ error: 'locationId and name required' }, 400);
    }

    const timestamp = Date.now();
    
    await env.EDEN_DB.prepare(`
      INSERT INTO waiting_list (location_id, name, timestamp)
      VALUES (?, ?, ?)
    `).bind(locationId, name.trim(), timestamp).run();

    // Get updated list
    const results = await env.EDEN_DB.prepare(
      'SELECT name, timestamp FROM waiting_list WHERE location_id = ? ORDER BY timestamp ASC'
    ).bind(locationId).all();
    
    const list = results.results.map(row => ({
      name: row.name,
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
      'SELECT name, timestamp FROM waiting_list WHERE location_id = ? ORDER BY timestamp ASC'
    ).bind(locationId).all();
    
    const list = results.results.map(row => ({
      name: row.name,
      timestamp: row.timestamp
    }));

    return jsonResponse({ success: true, list });
  } catch (error) {
    console.error('Waiting list remove error:', error);
    return jsonResponse({ error: error.message }, 500);
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
