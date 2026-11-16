/* Local stand-in for the JSONBin v3 API — for testing only, never deployed.
   Lets us exercise every save path without touching the real bin or using
   any of your JSONBin requests.

   Usage: node scripts/mock-jsonbin.js <seed.json> [port]
   Then run the server with:
     JSONBIN_API=http://127.0.0.1:4174/v3  JSONBIN_BIN_ID=test  JSONBIN_KEY=mock-key

   Behaves like JSONBin Free: 100 KB record limit, access key required.
   Test switches (POST /__mock with JSON): {"failReads":true}, {"failWrites":true},
   {"reset":true}; GET /__mock returns the stored record + request counts. */
const express = require('express');
const fs = require('fs');

const seedPath = process.argv[2];
const port = Number(process.argv[3]) || 4174;
const KEY = 'mock-key';
const LIMIT = 100 * 1024;

const seed = () => JSON.parse(fs.readFileSync(seedPath, 'utf8'));
let record = seed();
let flags = { failReads: false, failWrites: false };
const counts = { reads: 0, writes: 0 };

const app = express();
app.use(express.json({ limit: '5mb' }));
const auth = (req, res, next) => (req.get('X-Access-Key') === KEY || req.get('X-Master-Key') === KEY)
  ? next() : res.status(401).json({ message: 'You need to pass X-Master-Key or X-Access-Key in the header' });

app.get('/v3/b/:id/latest', auth, (req, res) => {
  counts.reads++;
  if (flags.failReads) return res.status(503).json({ message: 'Mock: read failure' });
  const meta = req.get('X-Bin-Meta') !== 'false';
  res.json(meta ? { record, metadata: { id: req.params.id, private: true } } : record);
});

app.put('/v3/b/:id', auth, (req, res) => {
  counts.writes++;
  if (flags.failWrites) return res.status(503).json({ message: 'Mock: write failure' });
  if (Buffer.byteLength(JSON.stringify(req.body)) > LIMIT) {
    return res.status(403).json({ message: 'Free users cannot create a record over 100kb.' });
  }
  record = req.body;
  res.json({ record, metadata: { parentId: req.params.id, private: true } });
});

app.get('/__mock', (req, res) => res.json({ flags, counts, entries: record.entries.length, strategies: record.strategies.length, record }));
app.post('/__mock', (req, res) => {
  if (req.body.reset) { record = seed(); counts.reads = 0; counts.writes = 0; }
  if ('failReads' in req.body) flags.failReads = !!req.body.failReads;
  if ('failWrites' in req.body) flags.failWrites = !!req.body.failWrites;
  res.json({ flags, counts });
});

app.listen(port, '127.0.0.1', () => console.log(`Mock JSONBin on http://127.0.0.1:${port}/v3 (seed: ${seedPath})`));
