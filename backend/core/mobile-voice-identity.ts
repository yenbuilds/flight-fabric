import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate, createPrivateKey, randomUUID } from 'node:crypto';
import { generate } from 'selfsigned';
import { now } from './time-source';

// This identity belongs to the optional HTTPS listener, independently of
// recognition sessions. Never install trust or replace an existing identity
// silently: phones explicitly trust this PC's CA once.
export async function loadMobileVoiceIdentity(directory: string, ips: string[]) {
  const at = now();
  const file = path.join(directory, 'identity.json');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let identity: { key: string; cert: string };
  try {
    identity = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('The phone connection identity could not be read.');
    const ca = await generate([{ name: 'commonName', value: `FlightFabric PC ${randomUUID().slice(0, 8)}` }], {
      keySize: 2048, algorithm: 'sha256',
      notBeforeDate: new Date(at - 300000),
      notAfterDate: new Date(at + 5 * 365 * 86400000),
      extensions: [
        { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
      ],
    });
    identity = { key: ca.private, cert: ca.cert };
    // Exclusive creation prevents concurrent setup from replacing phone trust.
    fs.writeFileSync(file, JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
  }
  const ca = new X509Certificate(identity.cert);
  if (!ca.ca || !ca.checkPrivateKey(createPrivateKey(identity.key))
      || Date.parse(ca.validTo) < at + 90 * 86400000) {
    throw new Error('The phone connection certificate needs renewal.');
  }
  const leaf = await generate([{ name: 'commonName', value: 'FlightFabric phone connection' }], {
    keySize: 2048, algorithm: 'sha256', ca: identity,
    notBeforeDate: new Date(at - 300000),
    notAfterDate: new Date(at + 90 * 86400000),
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [
        { type: 2, value: 'localhost' },
        ...[...new Set(['127.0.0.1', ...ips])].map(ip => ({ type: 7 as const, ip })),
      ] },
    ],
  });
  return { key: leaf.private, cert: leaf.cert, certificate: ca.raw, fingerprint: ca.fingerprint256 };
}
