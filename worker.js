/**
 * AJMAL SUPER 40 ERP - Cloudflare Worker entrypoint. update
 *
 * This keeps the existing frontend unchanged while providing the /api proxy
 * required by scripts.js. All ERP business logic remains in Google Apps
 * Script, and Google Sheets remains the authoritative datastore.
 *
 * Configure APPS_SCRIPT_WEB_APP_URL as a Cloudflare Worker environment
 * variable in the dashboard. Do not hard-code the Apps Script URL here.
 */

function jsonResponse_(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      ...extraHeaders
    }
  });
}

function corsHeaders_() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

async function handleApi_(request, env) {
  const headers = corsHeaders_();

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== 'POST') {
    return jsonResponse_({
      ok: false,
      error: 'Method not allowed. The ERP API accepts POST requests.'
    }, 405, {
      ...headers,
      'Allow': 'POST, OPTIONS'
    });
  }

  const target = String(env.APPS_SCRIPT_WEB_APP_URL || '').trim();
  if (!target) {
    return jsonResponse_({
      ok: false,
      error: 'APPS_SCRIPT_WEB_APP_URL is not configured for this Worker.'
    }, 500, headers);
  }

  let body = '';
  try {
    body = await request.text();
    JSON.parse(body || '{}');
  } catch (err) {
    return jsonResponse_({
      ok: false,
      error: 'Invalid JSON request.'
    }, 400, headers);
  }

  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache'
      },
      body,
      redirect: 'follow'
    });

    const text = await upstream.text();
    const contentType = upstream.headers.get('Content-Type') || '';

    // Preserve valid JSON from Apps Script. If the upstream response is not
    // JSON, return a clear diagnostic instead of letting the browser report
    // a misleading parse error.
    if (!contentType.toLowerCase().includes('application/json')) {
      try {
        JSON.parse(text || '{}');
      } catch (err) {
        return jsonResponse_({
          ok: false,
          error: `Google Apps Script returned a non-JSON response (HTTP ${upstream.status}).`,
          upstreamStatus: upstream.status
        }, 502, headers);
      }
    }

    return new Response(text || JSON.stringify({ ok: false, error: 'Empty backend response.' }), {
      status: upstream.status,
      headers: {
        ...headers,
        'Content-Type': contentType || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      }
    });
  } catch (err) {
    return jsonResponse_({
      ok: false,
      error: 'Could not reach the Google Apps Script backend: ' + String(err?.message || err)
    }, 502, headers);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // The existing Cloudflare frontend bridge calls the same-origin /api path.
    if (url.pathname === '/api' || url.pathname === '/api/') {
      return handleApi_(request, env);
    }

    // All non-API requests are served by the static ERP frontend.
    // Explicitly preserve UTF-8 for text assets so symbols such as
    // ✓ • → ↔ ⚙ are rendered correctly.
    if (env.ASSETS) {
      const assetResponse = await env.ASSETS.fetch(request);
      const contentType = assetResponse.headers.get('Content-Type') || '';

      const isTextAsset =
        /^text\//i.test(contentType) ||
        /javascript|json|xml|svg/i.test(contentType);

      if (isTextAsset && !/charset=/i.test(contentType)) {
        const headers = new Headers(assetResponse.headers);

        headers.set(
          'Content-Type',
          `${contentType}; charset=utf-8`
        );

        return new Response(assetResponse.body, {
          status: assetResponse.status,
          statusText: assetResponse.statusText,
          headers
        });
      }

      return assetResponse;
    }

    return new Response('ERP static asset binding is not configured.', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
};
