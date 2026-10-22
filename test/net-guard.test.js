import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BlockedAddressError, isPublicAddress, resolveAllowed } from '../src/net-guard.js';

test('classifies internal and special-purpose addresses as non-public', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.100.100.200', // CGNAT (Alibaba metadata)
    '0.0.0.0',
    '::1',
    '::',
    'fd00:ec2::254', // AWS IPv6 metadata
    'fe80::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:10.0.0.1',
  ]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});

test('accepts ordinary public addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

test('resolveAllowed blocks literals and names that point inside', async () => {
  await assert.rejects(resolveAllowed('127.0.0.1'), BlockedAddressError);
  await assert.rejects(resolveAllowed('[::1]'), BlockedAddressError);
  await assert.rejects(resolveAllowed('localhost'), BlockedAddressError);
});

test('resolveAllowed lets private addresses through when explicitly allowed', async () => {
  const [r] = await resolveAllowed('127.0.0.1', { allowPrivate: true });
  assert.equal(r.address, '127.0.0.1');
});
