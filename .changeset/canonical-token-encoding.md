---
'brobridge': patch
---

Reject non-canonical base64url spellings of the launch token and session MAC. Base64 discards the final character's padding bits, so several strings decoded to the same bytes; only the canonical spelling now redeems.
