import JSZip from 'jszip';

export async function buildZip(entries) {
  const archive = new JSZip();
  for (const entry of entries) archive.file(entry.path, entry.data);
  return archive.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
