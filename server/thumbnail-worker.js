'use strict';

const sharp = require('sharp');
sharp.cache(false);
sharp.concurrency(1);
process.once('disconnect', () => process.exit(0));

process.on('message', async ({ input, output }) => {
  try {
    // Decode only the first frame; reject decompression bombs before allocating.
    let result = await sharp(input, { limitInputPixels: 20_000_000, pages: 1, failOn: 'warning' })
      .autoOrient().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 65, effort: 2 }).toBuffer();
    if (result.length > 96 * 1024) {
      result = await sharp(result).resize({ width: 320, height: 320, fit: 'inside' }).webp({ quality: 45 }).toBuffer();
    }
    if (result.length > 96 * 1024) throw new Error('Preview exceeds size budget');
    require('node:fs').writeFileSync(output, result, { flag: 'wx', mode: 0o600 });
    process.send({ ok: true });
  } catch { process.send({ ok: false }); }
});
