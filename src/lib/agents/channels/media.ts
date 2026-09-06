import { fileTypeFromBuffer } from 'file-type';
import { channelFetch, MAX_FILE_SIZE_BYTES } from './http';

export { MAX_FILE_SIZE_BYTES };
export type ImageAttachment = { data: string; media_type: string };
export type FileAttachment = ImageAttachment & { filename: string; size: number };

export async function downloadImageAsBase64(url: string): Promise<ImageAttachment | null> {
  const response = await channelFetch(url);
  if (!response.ok) return null;
  const data = Buffer.from(await response.arrayBuffer());
  const type = await fileTypeFromBuffer(data);
  if (!type?.mime.startsWith('image/')) return null;
  return { data: data.toString('base64'), media_type: type.mime };
}

export async function downloadFileAsBase64(url: string, filename: string): Promise<FileAttachment | null> {
  const response = await channelFetch(url);
  if (!response.ok) return null;
  const data = Buffer.from(await response.arrayBuffer());
  return { data: data.toString('base64'), filename, size: data.length,
    media_type: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream' };
}
