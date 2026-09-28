import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export function validateEncodingSettings(format, quality, dimensions, palette = false, colors = 64) {
  if (!['png', 'jpeg', 'webp'].includes(format)) throw new Error(`Unsupported output format: ${format}`);
  if (format !== 'png' && (!Number.isInteger(quality) || quality < 1 || quality > 100)) throw new Error('Quality must be an integer from 1 to 100');
  if (!Number.isInteger(dimensions?.width) || dimensions.width < 1 || dimensions.width > 30000 || !Number.isInteger(dimensions?.height) || dimensions.height < 1 || dimensions.height > 30000) {
    throw new Error('Width and height must be integers from 1 to 30000');
  }
  if (typeof palette !== 'boolean') throw new Error('Palette reduction must be enabled or disabled');
  if (!Number.isInteger(colors) || colors < 2 || colors > 256) throw new Error('PNG palette colors must be an integer from 2 to 256');
}

export function variantPath(source, viewport, format) {
  const parsed = path.posix.parse(source);
  const extension = format === 'jpeg' ? '.jpg' : format === 'webp' ? '.webp' : '.png';
  return path.posix.join(parsed.dir, `${parsed.name}-${viewport}${extension}`);
}

export async function encodeBuffer({ input, dimensions, format, quality, palette = false, colors = 64 }) {
  validateEncodingSettings(format, quality, dimensions, palette, colors);
  const resized = sharp(input).resize({ width: dimensions.width, height: dimensions.height, fit: 'inside', withoutEnlargement: true });
  if (format === 'png' && palette) {
    const { data, info } = await resized.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const reduced = quantizeRgba(data, info.width, info.height, colors);
    const output = await sharp(reduced, { raw: { width: info.width, height: info.height, channels: 4 } })
      .png({ compressionLevel: 9, palette: true, colors: 256, quality: 100, dither: 1 })
      .toBuffer({ resolveWithObject: true });
    return output;
  }
  return encodeFormat(resized, format, quality).toBuffer({ resolveWithObject: true });
}

export async function renderImage({ source, dimensions, format, quality }) {
  return encodeBuffer({ input: source, dimensions, format, quality });
}

export async function encodeImage({ source, output, dimensions, format, quality }) {
  validateEncodingSettings(format, quality, dimensions);
  await mkdir(path.dirname(output), { recursive: true });
  let image = sharp(source).resize({ width: dimensions.width, height: dimensions.height, fit: 'inside', withoutEnlargement: true });
  image = encodeFormat(image, format, quality);
  await image.toFile(output);
  const metadata = await sharp(output).metadata();
  const outputStat = await stat(output);
  return { ...metadata, size: outputStat.size };
}

function encodeFormat(image, format, quality) {
  return format === 'png' ? image.png({ compressionLevel: 9 })
    : format === 'webp' ? image.webp({ quality })
      : image.jpeg({ quality });
}

// Sharp's PNG `colors` option controls palette bit depth in power-of-two steps,
// not an exact color limit. Quantize first so the UI value is honored exactly.
function quantizeRgba(data, width, height, maxColors) {
  const pixels = width * height;
  const maxSamples = 30000;
  const sampleStep = Math.max(1, Math.floor(pixels / maxSamples));
  const histogram = new Map();
  for (let pixel = 0; pixel < pixels; pixel += sampleStep) {
    const offset = pixel * 4;
    if (data[offset + 3] === 0) continue;
    const key = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
    const entry = histogram.get(key);
    if (entry) entry.count++;
    else histogram.set(key, { r: data[offset], g: data[offset + 1], b: data[offset + 2], count: 1 });
  }
  const samples = [...histogram.values()];
  if (!samples.length) return data;

  const boxes = [samples];
  while (boxes.length < maxColors) {
    let boxIndex = -1;
    let splitChannel = 0;
    let bestScore = -1;
    for (let index = 0; index < boxes.length; index++) {
      const box = boxes[index];
      if (box.length < 2) continue;
      const ranges = ['r', 'g', 'b'].map((channel) => {
        let min = 255; let max = 0;
        for (const color of box) { min = Math.min(min, color[channel]); max = Math.max(max, color[channel]); }
        return max - min;
      });
      const channel = ranges.indexOf(Math.max(...ranges));
      const score = ranges[channel] * Math.sqrt(box.reduce((sum, color) => sum + color.count, 0));
      if (score > bestScore) { bestScore = score; boxIndex = index; splitChannel = channel; }
    }
    if (boxIndex < 0) break;
    const channel = ['r', 'g', 'b'][splitChannel];
    const box = boxes.splice(boxIndex, 1)[0].sort((a, b) => a[channel] - b[channel]);
    const total = box.reduce((sum, color) => sum + color.count, 0);
    let cumulative = 0;
    let splitAt = 1;
    for (; splitAt < box.length; splitAt++) {
      cumulative += box[splitAt - 1].count;
      if (cumulative >= total / 2) break;
    }
    boxes.push(box.slice(0, splitAt), box.slice(splitAt));
  }

  const palette = boxes.map((box) => {
    let weight = 0; let r = 0; let g = 0; let b = 0;
    for (const color of box) { weight += color.count; r += color.r * color.count; g += color.g * color.count; b += color.b * color.count; }
    return [Math.round(r / weight), Math.round(g / weight), Math.round(b / weight)];
  });
  const lookup = new Uint8Array(32 * 32 * 32);
  for (let r = 0; r < 32; r++) for (let g = 0; g < 32; g++) for (let b = 0; b < 32; b++) {
    const red = r * 8 + 4; const green = g * 8 + 4; const blue = b * 8 + 4;
    let nearest = 0; let distance = Infinity;
    for (let index = 0; index < palette.length; index++) {
      const color = palette[index];
      const dr = red - color[0]; const dg = green - color[1]; const db = blue - color[2];
      const candidate = dr * dr + dg * dg + db * db;
      if (candidate < distance) { distance = candidate; nearest = index; }
    }
    lookup[(r << 10) | (g << 5) | b] = nearest;
  }

  const output = Buffer.from(data);
  let current = new Float32Array((width + 2) * 3);
  let next = new Float32Array((width + 2) * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (output[offset + 3] === 0) continue;
      const errorOffset = (x + 1) * 3;
      const r = Math.max(0, Math.min(255, output[offset] + current[errorOffset]));
      const g = Math.max(0, Math.min(255, output[offset + 1] + current[errorOffset + 1]));
      const b = Math.max(0, Math.min(255, output[offset + 2] + current[errorOffset + 2]));
      const color = palette[lookup[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)]];
      output[offset] = color[0]; output[offset + 1] = color[1]; output[offset + 2] = color[2];
      const er = r - color[0]; const eg = g - color[1]; const eb = b - color[2];
      current[errorOffset + 3] += er * 7 / 16; current[errorOffset + 4] += eg * 7 / 16; current[errorOffset + 5] += eb * 7 / 16;
      next[errorOffset - 3] += er * 3 / 16; next[errorOffset - 2] += eg * 3 / 16; next[errorOffset - 1] += eb * 3 / 16;
      next[errorOffset] += er * 5 / 16; next[errorOffset + 1] += eg * 5 / 16; next[errorOffset + 2] += eb * 5 / 16;
      next[errorOffset + 3] += er / 16; next[errorOffset + 4] += eg / 16; next[errorOffset + 5] += eb / 16;
    }
    [current, next] = [next, current];
    next.fill(0);
  }
  return output;
}
