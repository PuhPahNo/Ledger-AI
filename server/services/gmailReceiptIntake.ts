import path from 'node:path';

export interface GmailMimePart {
  filename?: string | null;
  mimeType?: string | null;
  body?: {
    data?: string | null;
    attachmentId?: string | null;
    size?: number | null;
  } | null;
  headers?: Array<{ name?: string | null; value?: string | null }> | null;
  parts?: GmailMimePart[] | null;
}

export interface GmailAttachmentCandidate {
  filename: string;
  mimeType: string;
  attachmentId: string;
}

export interface GmailBodyCandidate {
  filename: string;
  mimeType: 'text/plain';
  text: string;
  bodyLength: number;
  truncated: boolean;
}

const bodyTextLimit = 25_000;
const maxInlineImageBytes = 100_000;

const receiptKeywordPattern = /\b(receipt|invoice|tax invoice|sales receipt|order confirmation|purchase confirmation|payment receipt|payment received|amount paid|thanks for your (order|purchase)|your order|bill|statement)\b/i;
const amountPattern = /(?:[$€£]\s?\d[\d,]*(?:\.\d{2})?|\b\d[\d,]*\.\d{2}\s?(?:usd|cad|eur|gbp)\b)/i;
const totalPattern = /\b(total|subtotal|amount paid|amount due|balance due|paid|charged|payment)\b/i;
const documentNumberPattern = /\b(invoice|receipt|order)\s*(#|no\.?|number|id)?\s*[:\-]?\s*[a-z0-9-]{3,}/i;
const receiptFileNamePattern = /receipt|invoice|order|confirmation|bill/i;

export interface GmailMessageSignal {
  /** A receipt keyword plus corroborating evidence (amount, document number, or total wording). */
  isReceiptLike: boolean;
  /** A receipt keyword appears somewhere in the subject/sender/snippet. */
  hasReceiptKeyword: boolean;
}

export function messageReceiptSignal(value: string): GmailMessageSignal {
  const normalized = normalizeText(value);
  return {
    isReceiptLike: looksLikeReceiptOrInvoiceText(normalized),
    hasReceiptKeyword: receiptKeywordPattern.test(normalized),
  };
}

const noMessageSignal: GmailMessageSignal = { isReceiptLike: false, hasReceiptKeyword: false };

export function header(part: GmailMimePart | undefined | null, name: string): string | undefined {
  const match = part?.headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase());
  return match?.value ?? undefined;
}

export function collectReceiptAttachments(
  part: GmailMimePart | undefined | null,
  messageSignal: GmailMessageSignal = noMessageSignal,
): GmailAttachmentCandidate[] {
  if (!part) return [];
  const attachmentId = part.body?.attachmentId;
  const mimeType = part.mimeType ?? 'application/octet-stream';
  const filename = sanitizeFileName(part.filename || fallbackAttachmentName(mimeType));
  const disposition = header(part, 'Content-Disposition') ?? '';
  const size = part.body?.size ?? 0;
  const filenameIsReceiptLike = receiptFileNamePattern.test(filename);
  const isInlineImage = /^image\//i.test(mimeType)
    && /inline/i.test(disposition)
    && (size === 0 || size < maxInlineImageBytes)
    && !filenameIsReceiptLike;

  const current = attachmentId && !isInlineImage && isSupportedReceiptFile(mimeType, filename, messageSignal)
    ? [{ filename, mimeType, attachmentId }]
    : [];

  return [
    ...current,
    ...(part.parts ?? []).flatMap((child) => collectReceiptAttachments(child, messageSignal)),
  ];
}

export function buildEmailBodyCandidate(input: {
  payload: GmailMimePart | undefined | null;
  subject?: string;
  from?: string;
  date?: string;
}): GmailBodyCandidate | null {
  const plainText = collectBodyText(input.payload, 'text/plain').join('\n\n').trim();
  const htmlText = collectBodyText(input.payload, 'text/html').map(htmlToText).join('\n\n').trim();
  const body = normalizeText(plainText || htmlText);
  const headerText = normalizeText([input.subject, input.from, input.date].filter(Boolean).join('\n'));
  const combined = [headerText, body].filter(Boolean).join('\n\n');
  if (!body || !looksLikeReceiptOrInvoiceText(combined)) return null;

  const text = [
    input.subject ? `Subject: ${input.subject}` : null,
    input.from ? `From: ${input.from}` : null,
    input.date ? `Date: ${input.date}` : null,
    '',
    body,
  ].filter((line) => line !== null).join('\n');

  const truncated = text.length > bodyTextLimit;
  return {
    filename: sanitizeFileName(`${subjectSlug(input.subject) || 'gmail-body'}-receipt.txt`),
    mimeType: 'text/plain',
    text: truncated ? text.slice(0, bodyTextLimit) : text,
    bodyLength: text.length,
    truncated,
  };
}

export function looksLikeReceiptOrInvoiceText(value: string): boolean {
  const normalized = normalizeText(value);
  if (!receiptKeywordPattern.test(normalized)) return false;
  return amountPattern.test(normalized)
    || documentNumberPattern.test(normalized)
    || (/\binvoice\b/i.test(normalized) && totalPattern.test(normalized))
    || (/\breceipt\b/i.test(normalized) && totalPattern.test(normalized));
}

export function sanitizeFileName(fileName: string): string {
  const parsed = path.parse(fileName);
  const base = parsed.name.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80) || 'receipt';
  const ext = parsed.ext.replace(/[^a-z0-9.]+/gi, '').slice(0, 12);
  return `${base}${ext}`;
}

/**
 * Storage key for a Gmail-sourced receipt file. The content-hash prefix keeps two attachments
 * that share a filename in one message (e.g. two "invoice.pdf") from overwriting each other,
 * while identical bytes map to the same key (re-ingest is idempotent).
 */
export function gmailReceiptStorageKey(input: {
  connectionId: string;
  messageId: string;
  fileName: string;
  contentSha256: string;
}): string {
  return `receipts/gmail/${input.connectionId}/${input.messageId}/${input.contentSha256.slice(0, 16)}-${sanitizeFileName(input.fileName)}`;
}

function collectBodyText(part: GmailMimePart | undefined | null, mimeType: 'text/plain' | 'text/html'): string[] {
  if (!part) return [];
  const current = part.mimeType === mimeType && part.body?.data
    ? [Buffer.from(part.body.data, 'base64url').toString('utf8')]
    : [];
  return [
    ...current,
    ...(part.parts ?? []).flatMap((child) => collectBodyText(child, mimeType)),
  ];
}

function isSupportedReceiptFile(mimeType: string, fileName: string, messageSignal: GmailMessageSignal): boolean {
  const filenameIsReceiptLike = receiptFileNamePattern.test(fileName);
  const isBinaryReceiptType = /application\/pdf|image\//i.test(mimeType)
    || /\.(pdf|png|jpe?g|webp|heic|heif|gif)$/i.test(fileName);
  // A PDF or image can't be cheaply inspected here, so require at least a weak signal —
  // a receipt keyword in the message or filename — before flagging it. Anything that
  // slips through still faces the extractor's isReceipt verdict downstream.
  if (isBinaryReceiptType) return messageSignal.hasReceiptKeyword || filenameIsReceiptLike;
  // Text attachments were already classified against the message body, so hold them to
  // the stricter keyword-plus-evidence standard.
  if (/text\/plain|text\/html/i.test(mimeType) || /\.(txt|html?)$/i.test(fileName)) {
    return messageSignal.isReceiptLike || filenameIsReceiptLike;
  }
  return messageSignal.isReceiptLike && receiptFileNamePattern.test(`${mimeType} ${fileName}`);
}

function fallbackAttachmentName(mimeType: string): string {
  if (/pdf/i.test(mimeType)) return 'gmail-attachment.pdf';
  if (/png/i.test(mimeType)) return 'gmail-attachment.png';
  if (/jpe?g/i.test(mimeType)) return 'gmail-attachment.jpg';
  if (/webp/i.test(mimeType)) return 'gmail-attachment.webp';
  if (/heic/i.test(mimeType)) return 'gmail-attachment.heic';
  if (/html/i.test(mimeType)) return 'gmail-attachment.html';
  if (/text/i.test(mimeType)) return 'gmail-attachment.txt';
  return 'gmail-attachment';
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(html)
    .replace(/<\s*(script|style)[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|tr|h[1-6]|table)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)));
}

function normalizeText(value: string): string {
  return value
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function subjectSlug(subject?: string): string {
  return (subject ?? '')
    .replace(/^(fwd?|re):\s*/gi, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// "Find in Gmail" for one transaction
// ---------------------------------------------------------------------------------------------

export interface TransactionGmailQuery {
  /** The Gmail search string. */
  query: string;
  /** Merchant word(s) searched for (first one is used in the query). */
  merchantTerms: string[];
  /** Amount spellings searched for, e.g. ["54.99"] or ["1234.50", "1,234.50"]. */
  amountVariants: string[];
  /** Inclusive first day searched (YYYY-MM-DD). */
  from: string;
  /** Inclusive last day searched (YYYY-MM-DD). */
  to: string;
}

const descriptorPrefix = /^(sq|tst|sp|pp|paypal|py|dd|in|pos|ach|chk|debit|purchase)\s*\*\s*/i;
const merchantStopWords = new Set([
  'inc', 'llc', 'ltd', 'corp', 'com', 'www', 'the', 'and', 'payment', 'payments', 'purchase', 'pos',
  'debit', 'credit', 'card', 'online', 'store', 'recurring', 'autopay', 'ach', 'bill', 'billing',
  'subscription', 'usa', 'pmt', 'pymt', 'corporation', 'company', 'http', 'https', 'net', 'org',
  'mktp', 'marketplace', 'intl', 'international', 'svc', 'services', 'service', 'charge', 'fee',
  'help', 'visa', 'mastercard', 'amex', 'transaction', 'trans', 'order',
]);
const merchantAliases: Record<string, string> = {
  amzn: 'amazon',
  goog: 'google',
  msft: 'microsoft',
  aapl: 'apple',
  fb: 'facebook',
};

/** Distinctive words of a bank descriptor, most useful first: "SQ *BLUE BOTTLE #12" → ["blue", "bottle"]. */
export function merchantSearchTerms(merchant: string): string[] {
  const words = merchant
    .toLowerCase()
    .replace(descriptorPrefix, '')
    .replace(/\.(com|net|org|io|ai|co|app)\b/g, ' ')
    .split(/[^a-z0-9]+/)
    .map((word) => merchantAliases[word] ?? word)
    .filter((word) => word.length >= 3 && !/\d/.test(word) && !merchantStopWords.has(word));
  return [...new Set(words)].slice(0, 3);
}

/** How a total can appear in an email: "54.99", and with a thousands separator when ≥ $1,000. */
export function amountSearchVariants(amountCents: number): string[] {
  const cents = Math.abs(Math.trunc(amountCents));
  if (cents === 0) return [];
  const dollars = Math.floor(cents / 100);
  const fraction = String(cents % 100).padStart(2, '0');
  const plain = `${dollars}.${fraction}`;
  const grouped = `${dollars.toLocaleString('en-US')}.${fraction}`;
  return plain === grouped ? [plain] : [plain, grouped];
}

function shiftIsoDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function gmailDate(date: string): string {
  return date.replace(/-/g, '/');
}

/**
 * Gmail search for the receipt of one card transaction: within ±`windowDays` of the charge
 * (posted or authorized date), an email mentioning the exact amount OR the merchant name alongside
 * receipt wording. Gmail's `before:` is exclusive, hence the extra day.
 */
export function buildTransactionGmailQuery(input: {
  merchant: string;
  amountCents: number;
  date: string;
  authorizedDate?: string | null;
  windowDays?: number;
}): TransactionGmailQuery {
  const windowDays = input.windowDays ?? 7;
  const dates = [input.date, input.authorizedDate].filter((value): value is string => Boolean(value)).sort();
  const from = shiftIsoDate(dates[0]!, -windowDays);
  const to = shiftIsoDate(dates[dates.length - 1]!, windowDays);
  const merchantTerms = merchantSearchTerms(input.merchant);
  const amountVariants = amountSearchVariants(input.amountCents);

  const clauses = [
    ...amountVariants.map((variant) => `"${variant}"`),
    ...(merchantTerms[0] ? [`(${merchantTerms[0]} (receipt OR invoice OR order OR payment OR billing OR subscription))`] : []),
  ];
  const window = `after:${gmailDate(from)} before:${gmailDate(shiftIsoDate(to, 1))}`;
  const query = clauses.length > 0 ? `${window} (${clauses.join(' OR ')})` : window;
  return { query, merchantTerms, amountVariants, from, to };
}
