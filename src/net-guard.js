import dns from 'node:dns/promises';
import net from 'node:net';
import ipaddr from 'ipaddr.js';

export class BlockedAddressError extends Error {
  constructor(host, reason) {
    super(`Refusing to connect to ${host}: ${reason}`);
    this.name = 'BlockedAddressError';
    this.host = host;
  }
}

// ipaddr.js labels every special-purpose range (private, loopback, linkLocal,
// carrierGradeNat, uniqueLocal, reserved, 6to4, ...). Only plain "unicast" is a
// normal public address. process() unwraps IPv4-mapped IPv6 (::ffff:10.0.0.1).
export function isPublicAddress(ip) {
  try {
    return ipaddr.process(ip).range() === 'unicast';
  } catch {
    return false;
  }
}

/**
 * Resolve `hostname` and return the addresses that are safe to connect to.
 * Callers must connect to these addresses, not re-resolve the name, otherwise
 * DNS rebinding can swap in a private address after the check.
 */
export async function resolveAllowed(hostname, { allowPrivate = false } = {}) {
  const bare = stripBrackets(hostname);
  const literalFamily = net.isIP(bare);

  if (literalFamily) {
    if (!allowPrivate && !isPublicAddress(bare)) {
      throw new BlockedAddressError(hostname, 'address is not public');
    }
    return [{ address: bare, family: literalFamily }];
  }

  let records;
  try {
    records = await dns.lookup(bare, { all: true, verbatim: true });
  } catch (err) {
    const e = new Error(`DNS lookup failed for ${hostname}: ${err.code ?? err.message}`);
    e.code = 'DNS_FAILED';
    throw e;
  }

  const usable = allowPrivate ? records : records.filter((r) => isPublicAddress(r.address));
  if (usable.length === 0) {
    throw new BlockedAddressError(hostname, `resolves only to non-public addresses (${records.map((r) => r.address).join(', ')})`);
  }
  return usable;
}

/**
 * A `lookup` for net.connect / http.request that only ever hands back
 * `addresses`. Node then does its usual Happy Eyeballs across them (so an
 * unreachable IPv6 address falls back to IPv4) without resolving again.
 */
export function pinnedLookup(addresses) {
  return (_hostname, options, callback) => {
    const wanted = options.family ? addresses.filter((a) => a.family === options.family) : addresses;
    if (wanted.length === 0) {
      const err = new Error('No pinned address for the requested family');
      err.code = 'ENOTFOUND';
      return callback(err);
    }
    if (options.all) return callback(null, wanted);
    return callback(null, wanted[0].address, wanted[0].family);
  };
}

export function stripBrackets(hostname) {
  return hostname.replace(/^\[(.*)\]$/, '$1');
}
