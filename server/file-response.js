'use strict';

const { createReadStream, statSync } = require('node:fs');

// RFC 9110 permits ignoring Range. Ignore malformed, unknown and multiple ranges;
// return 416 only for a syntactically valid single range with no selected bytes.
function sendFile(req, reply, filePath, { mimeType, fileName, download = false }) {
  const size = statSync(filePath).size;
  const filename = encodeURIComponent(fileName || 'file').replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  reply.type(mimeType || 'application/octet-stream')
    .header('Accept-Ranges', 'bytes')
    .header('Cache-Control', 'private, max-age=86400')
    .header('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename}"; filename*=UTF-8''${filename}`);
  let start = 0, end = size - 1;
  if (req.method === 'GET' && !req.headers['if-range']) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (match && (match[1] || match[2])) {
      const first = match[1] ? BigInt(match[1]) : null;
      const last = match[2] ? BigInt(match[2]) : null;
      if (!(first !== null && last !== null && first > last)) {
        const length = BigInt(size);
        if (size === 0 || (first !== null && first >= length) || (first === null && last === 0n)) {
          return reply.code(416).header('Content-Range', `bytes */${size}`).header('Content-Length', 0).send();
        }
        start = first === null ? (last >= length ? 0 : Number(length - last)) : Number(first);
        end = first === null || last === null || last >= length ? size - 1 : Number(last);
        reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`);
      }
    }
  }
  reply.header('Content-Length', Math.max(0, end - start + 1));
  if (req.method === 'HEAD') {
    reply.hijack();
    reply.raw.writeHead(reply.statusCode, reply.getHeaders());
    reply.raw.end();
    return reply;
  }
  if (size === 0) return reply.send();
  const stream = createReadStream(filePath, { start, end });
  const cleanup = () => stream.destroy();
  reply.raw.once('close', cleanup);
  stream.once('close', () => reply.raw.removeListener('close', cleanup));
  return reply.send(stream);
}

module.exports = { sendFile };
