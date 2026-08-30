# Provider routing and deployment boundary

Reviewed: 2026-08-30. `shared/geminiModelRegistry.ts` is the sole allowed Gemini model registry. The gateway accepts only those IDs and keeps specialized IDs separate from text routing.

Each server call gets an immutable lease for a profile, quota group, and model. Credential failures are profile-wide, model availability is profile/model scoped, and daily quota plus temporary rate health are shared by quota-group/model. `Retry-After` and structured Google `RetryInfo` create bounded cooldowns. A 429 is considered daily exhaustion only when the provider explicitly says so; otherwise it is a temporary rate event. Daily exhaustion resets at the next midnight in `America/Los_Angeles`, matching Gemini's provider quota day across PST/PDT.

The gateway tries all ready profiles for a requested better model before considering the next ordered model candidate. An explicit provider Retry-After may be awaited within a bounded 60-second request window; ambiguous 429 responses are not blindly replayed. Stream startup can fail over before a chunk is emitted. Once any chunk is emitted, a later failure is an error envelope: clients must discard that logical attempt rather than concatenate partial output. Aborted calls are never retried.

`APP_DEPLOYMENT_MODE=private-aistudio` is mandatory for server credentials. The process also requires same-origin browser requests and POST for provider execution. Public or unconfigured deployments fail closed. This is appropriate only for an intentionally private AI Studio app; a public release needs real authentication, authorization, quota/rate limits, and monitoring.

Profiles are discovered exclusively from numbered AI Studio Secrets. The browser receives only ID, safe display label, HMAC fingerprint, quota group, profile status, per-model status/retry time, and the safe execution target used for a response. Friendly labels and enable/disable preferences may be stored locally; credential-looking labels are rejected. “Add” tells an operator the next secret name; “remove” only disables a profile because only the server-side AI Studio Settings UI can delete a secret.

Story critical roles use the explicit no-Lite quality floor and semantic QA fails closed. Any degraded story execution must be selected explicitly by policy and surfaced in route metadata; it never silently substitutes Lite. Translation uses the same provider gateway but retains an independent model policy.
