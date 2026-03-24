/**
 * Cloudflare Worker — Dashboard Refresh Proxy
 * Receives a POST from the dashboard and triggers the GitHub Actions build.
 * The GH_TOKEN secret is stored in Cloudflare (never exposed in the HTML).
 */

const REPO = 'AGwork-co/ag-it-dashboard';
const WORKFLOW = 'deploy.yml';
const ALLOWED_ORIGIN = 'https://agwork-co.github.io';

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(ALLOWED_ORIGIN) });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const token = env.GH_TOKEN;
    if (!token) {
      return new Response(JSON.stringify({ error: 'Server misconfigured' }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(ALLOWED_ORIGIN) }
      });
    }

    const res = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'AG-Dashboard-Refresh'
        },
        body: JSON.stringify({ ref: 'main' })
      }
    );

    if (res.status === 204) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders(ALLOWED_ORIGIN) }
      });
    }

    const body = await res.text();
    return new Response(JSON.stringify({ error: `GitHub returned ${res.status}`, detail: body }), {
      status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(ALLOWED_ORIGIN) }
    });
  }
};

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
