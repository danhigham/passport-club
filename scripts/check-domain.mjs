#!/usr/bin/env node
/**
 * Custom-domain health check.
 *
 * DNS changes take time to spread and TLS is issued only once they have, so
 * "is it working yet?" gets asked repeatedly. This answers it in one command,
 * and says which step is outstanding rather than just failing.
 *
 *   npm run domain
 */

import { promises as dns } from 'node:dns';

const APEX = process.env.DOMAIN || 'mypassport.club';
const WWW = `www.${APEX}`;
const SITE = process.env.NETLIFY_SITE || 'mypassport-club.netlify.app';

/**
 * Netlify's published apex load balancer. Resolved rather than hard-coded, so
 * this keeps telling the truth if Netlify ever changes the address.
 */
const APEX_TARGET = 'apex-loadbalancer.netlify.com';

const tick = (ok) => (ok ? '\u2713' : '\u2717');
const results = [];
const note = (ok, label, detail = '') =>
  results.push(`  ${tick(ok)} ${label}${detail ? `\n      ${detail}` : ''}`);

async function resolve(kind, name) {
  try {
    if (kind === 'A') return await dns.resolve4(name);
    if (kind === 'CNAME') return await dns.resolveCname(name);
    if (kind === 'NS') return await dns.resolveNs(name);
  } catch {
    return [];
  }
  return [];
}

async function head(url) {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
    return { status: res.status, location: res.headers.get('location') };
  } catch (err) {
    return { status: 0, error: String(err.message || err) };
  }
}

console.log(`\nChecking ${APEX}\n`);

const expected = await resolve('A', APEX_TARGET);
const apexA = await resolve('A', APEX);
const pointed = apexA.some((ip) => expected.includes(ip));
note(
  pointed,
  `apex A record points at Netlify`,
  pointed
    ? apexA.join(', ')
    : `currently ${apexA.join(', ') || '(none)'} \u2014 wanted one of ${expected.join(', ')}`,
);

const wwwCname = await resolve('CNAME', WWW);
const wwwOk = wwwCname.some((c) => c.replace(/\.$/, '').endsWith('netlify.app'));
note(
  wwwOk,
  `www is a CNAME to the Netlify site`,
  wwwOk ? wwwCname.join(', ') : `currently ${wwwCname.join(', ') || '(none)'} \u2014 wanted ${SITE}`,
);

const http = await head(`http://${APEX}`);
note(
  http.status === 301 || http.status === 308,
  `http redirects to https`,
  `HTTP ${http.status}${http.location ? ` \u2192 ${http.location}` : ''}`,
);

const https = await head(`https://${APEX}`);
note(https.status === 200, `https serves the site`, https.error ?? `HTTP ${https.status}`);

const wwwRes = await head(`https://${WWW}`);
const redirectsToApex = [301, 308].includes(wwwRes.status) && /\/\/[^/]*mypassport\.club/.test(wwwRes.location ?? '');
note(
  redirectsToApex || wwwRes.status === 200,
  `www resolves`,
  wwwRes.error ?? `HTTP ${wwwRes.status}${wwwRes.location ? ` \u2192 ${wwwRes.location}` : ''}`,
);

// Only meaningful once the site is actually being served from Netlify.
if (https.status === 200) {
  try {
    const res = await fetch(`https://${APEX}/`, { signal: AbortSignal.timeout(20000) });
    const html = await res.text();
    const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1];
    note(title === 'mypassport.club', `it is our site`, `title: ${title ?? '(none)'}`);
  } catch (err) {
    note(false, `it is our site`, String(err.message || err));
  }
}

console.log(results.join('\n'));

const done = results.every((r) => r.includes('\u2713'));
console.log(
  done
    ? `\nAll set. https://${APEX} is live.\n`
    : `\nNot finished yet. DNS changes can take up to a few hours to spread,\n` +
        `and Netlify issues the certificate only once the records resolve to it.\n`,
);
