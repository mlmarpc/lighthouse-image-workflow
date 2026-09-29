export function readNumericHeader(headers, name) {
  const value = headers.get(name);
  if (value === null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function targetFromMeasuredSsim(ssim) {
  if (!Number.isFinite(ssim)) return null;
  return Math.max(0.8, Math.min(1, Math.round(ssim * 100) / 100));
}
