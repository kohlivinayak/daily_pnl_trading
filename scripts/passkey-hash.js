/* Turns a passkey into the hash the server expects in PASSKEY_HASHES.
   Run:   node scripts/passkey-hash.js Nishant <passkey>
   Prints: Nishant:<hash>
   Paste the printed lines, joined with ";", into the PASSKEY_HASHES
   environment variable on Vercel. The passkey itself is never stored. */
const crypto = require('crypto');
const [name, key] = process.argv.slice(2);
if (!name || !key) {
  console.error('Usage: node scripts/passkey-hash.js <Name> <passkey>');
  process.exit(1);
}
console.log(`${name}:${crypto.createHash('sha256').update('tradedesk-v1:' + key.trim()).digest('hex')}`);
