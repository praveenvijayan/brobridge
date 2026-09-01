---
"@brobridge/adapters": patch
"@brobridge/client": patch
"@brobridge/core": patch
"brobridge": patch
---

Point `homepage`, `repository.url` and `bugs.url` at the repository that
actually builds these packages. npm provenance attests the source repository
and refuses a manifest that names a different one, so the old URLs would have
failed the first publish.
