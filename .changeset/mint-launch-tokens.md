---
"brobridge": patch
---

A bridge can mint more than one single-use launch address.

`Bridge.launchUrl()` returns `${origin}/?bt=<token>` with a fresh token each call. Every token is single-use with its own `launchTokenTtlMs` window; at most eight are live, and a ninth drops the oldest. `AuthGuard.mintLaunchToken()` backs it; `bridge.url`, `launchToken` and `tokenSpent` keep their meaning for the token minted at start. A token is minted only on the host's decision, never on a request from the browser.
