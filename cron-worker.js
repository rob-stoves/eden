/**
 * Eden Waiting List — Cron Worker
 *
 * Deploy this as a standalone Cloudflare Worker (separate from the Pages project).
 * Steps:
 *   1. Workers & Pages → Create application → Create Worker → paste this code
 *   2. Settings → Bindings → D1 Database → add binding named EDEN_DB → select your existing D1 database
 *   3. Settings → Variables → add: EDEN_API_TOKEN, RESEND_API_KEY, RESEND_FROM_EMAIL, SITE_URL
 *   4. Triggers → Cron Triggers → add e.g. "*/15 * * * *" (every 15 min)
 */

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduledNotifications(env));
  },

  // Health-check endpoint so you can test manually
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      await handleScheduledNotifications(env);
      return new Response('Done', { status: 200 });
    }
    return new Response('Eden cron worker', { status: 200 });
  }
};

const INACTIVE = new Set(['cancelled', 'finished', 'released']);

async function handleScheduledNotifications(env) {
  if (!env.EDEN_DB || !env.EDEN_API_TOKEN) {
    console.error('Missing EDEN_DB or EDEN_API_TOKEN');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const oneHourAgo = Date.now() - 3600000;
  const apiToken = env.EDEN_API_TOKEN.trim();
  const headers = { 'Authorization': apiToken, 'Content-Type': 'application/json' };
  const siteUrl = (env.SITE_URL || '').replace(/\/$/, '');

  // All unique (location_id, desired_date) pairs with eligible unnotified entries
  const pairResults = await env.EDEN_DB.prepare(`
    SELECT DISTINCT location_id, desired_date, location_name
    FROM waiting_list
    WHERE email IS NOT NULL AND email != ''
      AND desired_date >= ?
      AND (last_notified_at IS NULL OR last_notified_at < ?)
  `).bind(today, oneHourAgo).all();

  const pairs = pairResults.results;
  if (pairs.length === 0) {
    console.log('No eligible waiting list entries');
    return;
  }

  console.log(`Checking ${pairs.length} location/date pairs`);

  // Fetch desk list once per unique location
  const locationIds = [...new Set(pairs.map(p => p.location_id))];
  const desksByLocation = {};

  for (const locationId of locationIds) {
    const res = await fetch(
      `https://public-api.eden.io/locations?type=desks&parent_id=${encodeURIComponent(locationId)}`,
      { headers }
    ).catch(() => null);
    if (!res || !res.ok) { console.error(`Failed to fetch desks for ${locationId}`); continue; }
    const json = await res.json().catch(() => []);
    const all = Array.isArray(json) ? json : [];
    const desks = all.filter(d => (d.title || '').length <= 3);
    desksByLocation[locationId] = {
      desks,
      deskIds: new Set(desks.map(d => d.location_id).filter(Boolean))
    };
    console.log(`Location ${locationId}: ${desks.length} desks`);
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
    console.log(`${date} @ ${locationId}: ${freeDesks.length} free desks`);
    if (freeDesks.length === 0) continue;

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
      const unsubscribeUrl = siteUrl ? `${siteUrl}/waitinglist/unsubscribe?token=${entry.token}` : null;

      const sent = await sendEmail(env, {
        to: entry.email,
        name: entry.name,
        locationName: locationName || 'the office',
        deskName: freeDesks[0]?.title || null,
        otherNames,
        unsubscribeUrl,
        date
      });

      if (sent) {
        await env.EDEN_DB.prepare(
          'UPDATE waiting_list SET notified = 1, last_notified_at = ? WHERE id = ?'
        ).bind(now, entry.id).run();
        console.log(`Notified ${entry.name} for ${date}`);
      }
    }
  }
}

async function sendEmail(env, { to, name, locationName, deskName, otherNames, unsubscribeUrl, date }) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return false;

  const from = env.RESEND_FROM_EMAIL || 'noreply@optimizely.com';

  const deskLine = deskName
    ? `<p>Desk <strong>${deskName}</strong> is free — head in to Eden now to grab it.</p>`
    : `<p>Head in to Eden now to grab a spot.</p>`;

  let raceLine = '';
  if (otherNames && otherNames.length > 0) {
    const nameList = otherNames.length === 1
      ? otherNames[0]
      : otherNames.slice(0, -1).join(', ') + ' and ' + otherNames[otherNames.length - 1];
    raceLine = `<p>This email has also been sent to <strong>${nameList}</strong> — it's a race to book!</p>`;
  }

  let edenUrl = 'https://optimizely.team.eden.io/reservations/desk';
  if (date) {
    const [year, month, day] = date.split('-');
    edenUrl += `?allDay=true&date=${month}-${day}-${year}`;
  }

  const unsubLine = unsubscribeUrl
    ? `<p style="color:#999;font-size:12px;">Don't want these emails? <a href="${unsubscribeUrl}">Remove yourself from the waiting list</a>.</p>`
    : '';

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [to],
        subject: deskName
          ? `Desk ${deskName} is free at ${locationName}!`
          : `A desk is free at ${locationName}!`,
        html: `<p>Hi ${name},</p>
<p>Good news — a desk has become available at <strong>${locationName}</strong>.</p>
${deskLine}
${raceLine}
<p><strong>What to do next:</strong></p>
<ol>
  <li><a href="${edenUrl}">Log in to Eden</a> via Okta to book your desk</li>
</ol>
${unsubLine}`
      })
    });
    return res.ok;
  } catch (e) {
    console.error('Email send error:', e);
    return false;
  }
}
