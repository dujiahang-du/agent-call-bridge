import type { AppConfig } from '../shared/contracts.js';

/** One identity for consent, authorization, dispatch and per-destination limits. */
export function canonicalDestination(config: AppConfig): string {
  if (config.mode === 'sip') {
    const sip = config.providers.sip;
    const host = sip.server.toLowerCase();
    const transport = sip.transport.toLowerCase();
    if (!/^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)$/.test(host) ||
        !/^[a-zA-Z0-9_.+\-]{1,64}$/.test(sip.extension) ||
        !Number.isInteger(sip.port) || sip.port < 1 || sip.port > 65535 ||
        !['udp', 'tcp'].includes(transport)) return '';
    return `sip:${sip.extension}@${host}:${sip.port};transport=${transport}`;
  }
  const number = config.recipient.countryCode + config.recipient.number;
  return /^\+[1-9]\d{6,14}$/.test(number) ? number : '';
}
