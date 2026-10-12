import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, authEnabled, verifySessionToken } from "@/lib/session";

/**
 * Every page and server action needs a valid session, except the login page and the container
 * healthcheck. Unauthenticated visitors are sent to /login and returned afterwards.
 */
export function proxy(request: NextRequest) {
  if (!authEnabled()) return NextResponse.next();
  if (verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  const login = new URL("/login", request.url);
  const back = request.nextUrl.pathname + request.nextUrl.search;
  if (back !== "/") login.searchParams.set("next", back);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except the login page, the healthcheck, and static assets.
  matcher: ["/((?!login|api/health|_next/static|_next/image|favicon.ico).*)"],
};
