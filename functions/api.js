/**
 * Cloudflare Pages Function: same-origin API proxy for the ERP frontend.
 * Configure APPS_SCRIPT_WEB_APP_URL in Cloudflare Pages environment variables.
 */
export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response('', {
      status: 204,
      headers: {
        'Allow': 'POST, OPTIONS'
      }
    });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ok:false, error:'Method not allowed.'}), {
      status: 405,
      headers: {'Content-Type':'application/json', 'Allow':'POST, OPTIONS'}
    });
  }

  const target = String(env.APPS_SCRIPT_WEB_APP_URL || '').trim();
  if (!target) {
    return new Response(JSON.stringify({
      ok:false,
      error:'APPS_SCRIPT_WEB_APP_URL is not configured in Cloudflare Pages.'
    }), {
      status: 500,
      headers: {'Content-Type':'application/json'}
    });
  }

  let body;
  try {
    body = await request.text();
    JSON.parse(body || '{}');
  } catch (err) {
    return new Response(JSON.stringify({ok:false, error:'Invalid JSON request.'}), {
      status: 400,
      headers: {'Content-Type':'application/json'}
    });
  }

  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({
      ok:false,
      error:'Could not reach the Google Apps Script backend: ' + String(err?.message || err)
    }), {
      status: 502,
      headers: {'Content-Type':'application/json'}
    });
  }
}
