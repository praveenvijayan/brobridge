---
"brobridge": minor
---

Name the session cookie for the port the bridge is bound to (`bb_session_<port>`).

Browsers keep one cookie jar per host, not per port, so two bridges on `127.0.0.1` that both set `bb_session` overwrote each other: a host application running a launcher and the applications it starts saw each tab log the previous one out. `SESSION_COOKIE_NAME` is replaced by `sessionCookieName(authority)` and `SESSION_COOKIE_PREFIX`; cookie redaction covers the new names.
