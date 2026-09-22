---
"brobridge": patch
---

The session cookie is named for the bound port: `bb_session_<port>`.

A browser keeps one cookie jar per host whatever the port, so under the one shared name `bb_session` every bridge on `127.0.0.1` overwrote the cookie of every other. Two bridges open in one browser each had its tab refused with a `403` on the next reload. Now each bridge sets and reads a cookie of its own and neither evicts the other. The MAC binding to the authority is unchanged, so a cookie planted under a bridge's name still does not verify. `sessionCookieName(authority)` and `AuthGuard.cookieName` give the name; `SESSION_COOKIE_NAME` is now its prefix. A session minted under the old name is not read, so a tab opened before the upgrade needs a fresh launch address.
