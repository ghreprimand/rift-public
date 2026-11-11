'use strict';

const { createHash } = require('node:crypto');
const { gzipSync, brotliCompressSync, constants } = require('node:zlib');

function asset(body, type) {
  const plain = Buffer.from(body);
  return { type, plain, gzip: gzipSync(plain), br: brotliCompressSync(plain, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }),
    etag: 'W/"' + createHash('sha256').update(plain).digest('hex') + '"' };
}
function sendAsset(request, reply, cached) {
  reply.type(cached.type).header('Cache-Control', 'private, max-age=0, must-revalidate').header('Vary', 'Accept-Encoding').header('ETag', cached.etag);
  const accepted = String(request.headers['accept-encoding'] || '').split(',').map(part => part.trim());
  const qualities = new Map(accepted.map(part => {
    const [name, ...parameters] = part.split(';').map(value => value.trim());
    const quality = parameters.find(value => value.startsWith('q='));
    const number = quality ? Number(quality.slice(2)) : 1;
    return [name.toLowerCase(), Number.isFinite(number) && number >= 0 && number <= 1 ? number : 0];
  }));
  const quality = name => qualities.get(name) ?? (name === 'identity' ? qualities.get('*') === 0 ? 0 : 1 : qualities.get('*') ?? 0);
  const selected = ['br', 'gzip', 'identity'].sort((a, b) => quality(b) - quality(a))[0];
  if (!quality(selected)) return reply.code(406).type('text/plain').send('No acceptable content encoding');
  if (String(request.headers['if-none-match'] || '').split(',').map(value => value.trim()).some(value => value === cached.etag || value === '*')) return reply.code(304).send();
  const encoding = selected === 'identity' ? null : selected;
  if (encoding) reply.header('Content-Encoding', encoding);
  return reply.send(encoding ? cached[encoding] : cached.plain);
}
module.exports = { asset, sendAsset };
