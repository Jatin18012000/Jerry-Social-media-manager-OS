import { NextResponse, type NextRequest } from 'next/server';

import { SESSION_COOKIE, verifySessionToken } from '@/lib/session';

/**
 * Gate on every route — PRD §41.
 *
 * The app binds to the LAN so an iPad can reach it (§46), which means every
 * device on the network can reach it. §22 makes human approval the one
 * mandatory gate in V1; that gate is worth nothing if anyone on the wifi can
 * click Approve.
 *
 * Fails closed. A missing SESSION_SECRET redirects to a login page that
 * explains the problem, rather than silently leaving the app open — a
 * misconfiguration should never be indistinguishable from "no auth needed".
 */
export async function middleware(request: NextRequest) {
  const secret = process.env.SESSION_SECRET;
  const { pathname } = request.nextUrl;

  if (pathname.startsWith('/login')) {
    return NextResponse.next();
  }

  if (!secret || secret.length < 32) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('reason', 'unconfigured');
    return NextResponse.redirect(url);
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(token, secret)) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  // Come back to where they were heading once they are in.
  if (pathname !== '/') url.searchParams.set('next', pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next's own assets and the favicon.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
