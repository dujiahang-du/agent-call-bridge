# Third-party notices

Agent Call Bridge original code is MIT licensed. Dependencies are used under their own licenses. Lockfile records exact JavaScript dependency versions; shipped packages retain their upstream license files. The portable distribution is provided without any cloud account, credentials, voice-line entitlement or third-party service subscription.

| Component | License | Use / source |
| --- | --- | --- |
| Node.js 22 LTS | MIT plus bundled third-party notices | Windows runtime, `runtime/LICENSE`; https://nodejs.org/ |
| Fastify and official plugins | MIT | Local backend; https://github.com/fastify/fastify |
| React / React DOM | MIT | Interface; https://github.com/facebook/react |
| Vite | MIT | Build tooling, not a runtime service; https://github.com/vitejs/vite |
| Twilio Node SDK | MIT | Telephony request/TwiML/signature adapter; https://github.com/twilio/twilio-node |
| Alibaba Cloud TypeScript SDK | Apache-2.0 | VMS request and status adapter; https://github.com/aliyun/alibabacloud-typescript-sdk |
| MCP TypeScript SDK | MIT | Optional stdio connector; https://github.com/modelcontextprotocol/typescript-sdk |
| Zod | MIT | Input validation; https://github.com/colinhacks/zod |
| baresip / libre | BSD-3-Clause | Optional native SIP process; upstream license copies and source hashes in `native/sip/`; https://github.com/baresip/baresip and https://github.com/baresip/re |
| Gitleaks | MIT | Project-local release safety check only; https://github.com/gitleaks/gitleaks |
| Microsoft Windows speech / DPAPI | Operating system component | Uses locally installed Windows components; no Microsoft voice files are redistributed. |

OpenClaw voice-call was researched as an architecture reference. Its complete platform is not a dependency. Source with missing or unresolved upstream licensing was not copied. The SIP executable uses a small original working-directory-only launcher with unmodified fixed upstream source, built by the scripts in this repository.
