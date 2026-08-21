import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export function normalizeUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Die Adresse ist keine gültige URL.");
  }
  if (url.protocol !== "https:") throw new Error("Nur HTTPS-Links sind erlaubt.");
  if (url.username || url.password) throw new Error("Links mit Zugangsdaten sind nicht erlaubt.");
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (url.port === "443") url.port = "";
  return url;
}

export async function assertPublicUrl(
  value: string | URL,
  lookup: typeof dnsLookup = dnsLookup,
): Promise<URL> {
  const url = value instanceof URL ? normalizeUrl(value.toString()) : normalizeUrl(value);
  const literal = stripIpv6Brackets(url.hostname);
  const addresses = isIP(literal)
    ? [{ address: literal, family: isIP(literal) }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("Diese Adresse ist aus Sicherheitsgründen nicht erreichbar.");
  }
  return url;
}

export function isPublicAddress(address: string): boolean {
  const normalized = stripIpv6Brackets(address.toLowerCase().split("%")[0] ?? "");
  if (normalized.startsWith("::ffff:")) {
    return isPublicAddress(normalized.slice("::ffff:".length));
  }
  const family = isIP(normalized);
  if (family === 4) return isPublicIpv4(normalized);
  if (family === 6) return isPublicIpv6(normalized);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const [a, b, c] = address.split(".").map(Number);
  if ([a, b, c].some((value) => !Number.isInteger(value))) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  if (address === "::" || address === "::1") return false;
  const first = Number.parseInt(address.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xffc0) === 0xfe80) return false;
  if ((first & 0xff00) === 0xff00) return false;
  return true;
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}
