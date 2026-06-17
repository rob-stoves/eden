/**
 * Cloudflare Pages Middleware
 *
 * Gates /newBrand.html behind a URL token.
 * Set the DISPLAY_TOKEN environment variable in your Cloudflare Pages
 * project settings (Settings → Environment variables).
 *
 * Access the page with: /newBrand.html?token=<your-token>
 * Optional display flags: &showNames=false  &metricFocus=occupied
 */
export async function onRequest(context) {
    const { request, next, env } = context;
    const url = new URL(request.url);

    if (url.pathname === '/newBrand.html') {
        const provided = url.searchParams.get('token');
        const expected = env.DISPLAY_TOKEN;

        if (!expected) {
            // DISPLAY_TOKEN not configured — block access so the page isn't
            // accidentally public during initial deployment.
            return new Response('Display token not configured. Set DISPLAY_TOKEN in Cloudflare Pages environment variables.', {
                status: 503,
                headers: { 'Content-Type': 'text/plain' },
            });
        }

        if (!provided || provided !== expected) {
            return new Response('Access denied. A valid ?token= is required.', {
                status: 401,
                headers: { 'Content-Type': 'text/plain' },
            });
        }
    }

    return next();
}
