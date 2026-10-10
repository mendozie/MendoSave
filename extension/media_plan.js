// Preserve the requested codec and height on both SABR and capture routes.
function processingOptions({ format, transcode = false, requestedHeight = 0, sourceHeight = 0 }) {
  const audioOnly = format === 'mp3';
  const downscale = !audioOnly && requestedHeight > 0 && sourceHeight > requestedHeight;
  return { transcode: audioOnly || Boolean(transcode) || downscale, scaleHeight: downscale ? requestedHeight : 0 };
}
async function aacCodec(sourceCodec, getEncodable) {
  if (sourceCodec === 'aac') return 'aac';
  const codec = await getEncodable(['aac']);
  if (codec !== 'aac') throw new Error('Кодировщик AAC недоступен: используется FFmpeg.');
  return codec;
}
globalThis.MendoMediaPlan = { processingOptions, aacCodec };
if (typeof module !== 'undefined') module.exports = { processingOptions, aacCodec };
