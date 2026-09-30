/**
 * AJMAL SUPER 40 ERP - Cloudflare Worker entrypoint.
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

    const responseBody = text || JSON.stringify({ ok: false, error: 'Empty backend response.' });
    const responseHeaders = {
      ...headers,
      'Content-Type': contentType || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    };

    // Personalized ERP JSON must remain uncached, but compressing it in the
    // Worker significantly reduces transfer time for larger bootstrap/report
    // responses. Never double-compress an upstream encoded response.
    const acceptsGzip = /(^|,)\s*gzip\s*(,|$)/i.test(request.headers.get('Accept-Encoding') || '');
    const alreadyEncoded = !!upstream.headers.get('Content-Encoding');
    if(acceptsGzip && !alreadyEncoded && responseBody.length >= 4096 && typeof CompressionStream !== 'undefined'){
      responseHeaders['Content-Encoding'] = 'gzip';
      responseHeaders['Vary'] = 'Accept-Encoding';
      return new Response(new Blob([responseBody]).stream().pipeThrough(new CompressionStream('gzip')), {
        status: upstream.status,
        headers: responseHeaders
      });
    }

    return new Response(responseBody, {
      status: upstream.status,
      headers: responseHeaders
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

      const assetHeaders = new Headers(assetResponse.headers);
      const pathname = url.pathname.toLowerCase();
      const isHtml = /\.html?$/.test(pathname) || pathname === '/';
      const isVersioned = url.searchParams.has('v') || /[-._](?:20\d{6}|v?\d+)$/.test(pathname.replace(/\.[^.]+$/,''));

      if (isTextAsset && !/charset=/i.test(contentType)) {
        assetHeaders.set('Content-Type', `${contentType}; charset=utf-8`);
      }

      if(isHtml){
        assetHeaders.set('Cache-Control','no-cache, must-revalidate');
      }else if(isVersioned){
        assetHeaders.set('Cache-Control','public, max-age=31536000, immutable');
      }else if(/\.(?:js|css|svg|png|jpg|jpeg|webp|ico|woff2?)$/i.test(pathname)){
        assetHeaders.set('Cache-Control','public, max-age=86400, stale-while-revalidate=604800');
      }

      return new Response(assetResponse.body, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers: assetHeaders
      });
    }

    return new Response('ERP static asset binding is not configured.', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
};
