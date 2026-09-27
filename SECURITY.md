# Security and privacy

## Intended use
Contact the operator or recipients who explicitly agree to receive calls. No bulk marketing. Default mode is Mock. Saving a number or credentials never grants permission to call.

## Local boundary
The management server binds to IPv4 loopback only. Protected routes require a random local bearer token and validate Host/Origin; encoded route variants are covered by regression tests. Tokens never appear in rendered pages or normal logs. The launcher passes its token through a URL fragment, which the UI removes immediately and retains in session storage.

The Windows launcher/server creates a current-user-restricted `.local` directory. DPAPI encrypts configuration for the current Windows user. Runtime records, token files and speech data are not Git artifacts. Other users with administrator or equivalent access, malware running as the same user, or a compromised browser can still access local data; this tool is not a sandbox for hostile local code.

## Telephony boundary
Only a separately authenticated callback listener should be exposed through an operator-managed HTTPS endpoint. Never expose the management server. Twilio signatures use the complete configured external URL and complete form body. Calls are bound to the expected account, recipient and pending decision; PIN, expiry and one-time reply rules apply.

No arbitrary commands, approval escalation or permission grants are accepted by telephone. Unknown dial acceptance does not cause redial. Configuration changes, pause, restart and explicit disable revoke automatic real-call authorization. Provider cancellation may be unavailable; Alibaba SingleCallByTts is one such limitation.

The experimental SIP build is UDP/TCP with no TLS/SRTP. Use only a trusted local network for this version. The native control socket is loopback-only; only the project-verified binary and manifest are accepted. No claim is made about carrier or ATA interoperability.

## Publication and reports
Before each checkpoint, inspect precisely selected files and scan staged contents plus history. Before initial public release, scan all local history and the release file list; runtime databases, recordings, credentials, phone numbers and private material must not be included. Never force push or rewrite published history to conceal a secret.

Do not post credentials, raw logs, full telephone numbers, `.local`, authentication files or call recordings in issues. If a real secret leaks, immediately inform its owner, revoke/rotate it, and coordinate history/artifact cleanup; deleting a file alone is insufficient.
