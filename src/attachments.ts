// Files and images attached to a message. Images travel as base64 image blocks; any other
// file is referenced by its absolute path, which Claude reads with its Read tool.

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface ImageAttachment {
  kind: 'image';
  name: string;
  mediaType: ImageMediaType;
  data: string;
}

export interface FileAttachment {
  kind: 'file';
  name: string;
  path: string;
}

/** Text selected in a note ("Ask Claude about selection"), sent in the message's context block. */
export interface SelectionAttachment {
  kind: 'selection';
  /** Note name, for the chip. */
  name: string;
  /** Vault-relative path of the note. */
  path: string;
  fromLine: number;
  toLine: number;
  text: string;
}

export type Attachment = ImageAttachment | FileAttachment | SelectionAttachment;

const MEDIA_TYPES: Record<string, ImageMediaType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

// The Messages API rejects images over 5 MB (base64) or 8000 px on a side.
const MAX_BYTES = 3_750_000;
const MAX_EDGE = 8000;
const RESIZE_EDGE = 2576;

export function mimeForExtension(extension: string): ImageMediaType | undefined {
  const key = extension.toLowerCase();
  return Object.hasOwn(MEDIA_TYPES, key) ? MEDIA_TYPES[key] : undefined;
}

export function imageDataUrl(image: ImageAttachment): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

export function toImageBlock(image: ImageAttachment) {
  return { type: 'image' as const, source: { type: 'base64' as const, media_type: image.mediaType, data: image.data } };
}

function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Image encoding failed'))), type, quality);
  });
}

/**
 * Reads an image into an attachment. Images the API would reject (unsupported type, too
 * large in bytes or pixels) are redrawn at most 2576 px on the long edge. Returns null
 * when the image cannot be decoded.
 */
export async function imageFromBlob(blob: Blob, name: string): Promise<ImageAttachment | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    const longEdge = Math.max(bitmap.width, bitmap.height);
    const supported = (Object.values(MEDIA_TYPES) as string[]).includes(blob.type);
    let output = blob;
    if (!supported || blob.size > MAX_BYTES || longEdge > MAX_EDGE) {
      const scale = Math.min(1, RESIZE_EDGE / longEdge);
      const canvas = activeDocument.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const keepPng = blob.type === 'image/png' || blob.type === 'image/gif';
      output = await encode(canvas, keepPng ? 'image/png' : 'image/jpeg', 0.88);
      if (output.size > MAX_BYTES) output = await encode(canvas, 'image/jpeg', 0.8);
    }
    bitmap.close();
    const data = Buffer.from(await output.arrayBuffer()).toString('base64');
    return { kind: 'image', name, mediaType: output.type as ImageMediaType, data };
  } catch {
    return null;
  }
}

/** Absolute path of a file dropped or picked in Obsidian (Electron), or null when unavailable. */
export function filePathOf(file: File): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { webUtils?: { getPathForFile(file: File): string } };
    const resolved = electron.webUtils?.getPathForFile(file);
    if (resolved) return resolved;
  } catch {
    // Older Electron without webUtils: fall back to File.path below.
  }
  return (file as File & { path?: string }).path || null;
}
