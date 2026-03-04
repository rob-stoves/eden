/**
 * Cloudflare Pages Function - Eden API Proxy
 * 
 * This function proxies requests to the Eden API, bypassing CORS restrictions.
 * Requests to /api/* are forwarded to https://public-api.eden.io/*
 */

export async function onRequest(context) {
    const { request } = context;
    
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
    const url = new URL(request.url);
    const pathAfterApi = url.pathname.replace(/^\/api/, '') || '/';
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
