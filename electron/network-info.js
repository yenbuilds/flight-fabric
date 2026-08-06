'use strict';

const PRIVATE_172_RE = /^172\.(1[6-9]|2[0-9]|3[01])\./;
const VIRTUAL_INTERFACE_RE = /(docker|wsl|hyper-v|vethernet|vmware|virtualbox|vbox|tailscale|zerotier|vpn|tunnel|tun|tap|bridge|loopback)/i;
const WIFI_INTERFACE_RE = /(wi-?fi|wlan|wireless)/i;
const ETHERNET_INTERFACE_RE = /(ethernet|^eth\d*$|^en\d+$|lan)/i;

function scoreLocalIPv4Address(interfaceName, address) {
  const name = String(interfaceName || '');
  const host = String(address || '').trim();
  let score = 0;

  if (host.startsWith('192.168.')) score += 400;
  else if (host.startsWith('10.')) score += 300;
  else if (PRIVATE_172_RE.test(host)) score += 200;
  else if (host.startsWith('169.254.')) score -= 1000;
  else score -= 500;

  if (WIFI_INTERFACE_RE.test(name)) score += 120;
  else if (ETHERNET_INTERFACE_RE.test(name)) score += 80;

  if (VIRTUAL_INTERFACE_RE.test(name)) score -= 250;

  return score;
}

function isUsableIPv4Network(network) {
  if (!network || network.internal || !network.address) return false;
  return network.family === 'IPv4' || network.family === 4;
}

function getLocalIPv4AddressesFromInterfaces(nets) {
  const results = [];

  for (const name of Object.keys(nets || {})) {
    const networks = Array.isArray(nets[name]) ? nets[name] : [];
    for (const network of networks) {
      if (!isUsableIPv4Network(network)) continue;
      results.push({
        address: network.address,
        score: scoreLocalIPv4Address(name, network.address),
        index: results.length,
      });
    }
  }

  const seen = new Set();
  return results
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    })
    .filter((entry) => {
      if (seen.has(entry.address)) return false;
      seen.add(entry.address);
      return true;
    })
    .map((entry) => entry.address);
}

module.exports = {
  getLocalIPv4AddressesFromInterfaces,
  scoreLocalIPv4Address,
};
