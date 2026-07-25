import { isIP } from 'node:net';

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number);

  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
    return true;
  }

  const [first, second] = octets as [number, number, number, number];

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();

  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('::ffff:')
  );
}

export function approvedPublicHttpsOrigin(value: string | undefined): string {
  const message =
    'PILOT_WEBHOOK_BASE_URL must be an approved public HTTPS origin routed through Caddy';

  if (!value) {
    throw new Error(message);
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(message);
  }

  const hostname = url.hostname.toLowerCase();
  const ipVersion = isIP(hostname);
  const localHostname =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    !hostname.includes('.');

  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    localHostname ||
    (ipVersion === 4 && isPrivateIpv4(hostname)) ||
    (ipVersion === 6 && isPrivateIpv6(hostname))
  ) {
    throw new Error(message);
  }

  return url.origin;
}
