export type ZipEntry = { path: string; data: Uint8Array };
export function buildZip(entries: ZipEntry[]): Promise<Uint8Array>;
