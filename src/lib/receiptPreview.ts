export type ReceiptPreviewKind = 'pdf' | 'image' | 'html' | 'text' | 'unsupported';

export function receiptPreviewKind(mimeType?: string | null, fileName?: string | null): ReceiptPreviewKind {
  const normalizedMime = (mimeType ?? '').toLowerCase();
  const normalizedName = (fileName ?? '').toLowerCase();

  if (normalizedMime === 'application/pdf' || normalizedName.endsWith('.pdf')) return 'pdf';
  if (normalizedMime === 'text/html' || /\.html?$/i.test(normalizedName)) return 'html';
  if (normalizedMime.startsWith('text/') || /\.(txt|md|markdown|csv|tsv|json|log)$/i.test(normalizedName)) return 'text';
  if (isBrowserRenderableImage(normalizedMime, normalizedName)) return 'image';
  return 'unsupported';
}

function isBrowserRenderableImage(mimeType: string, fileName: string): boolean {
  if (/^image\/(png|jpe?g|gif|webp|svg\+xml)$/i.test(mimeType)) return true;
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(fileName);
}
