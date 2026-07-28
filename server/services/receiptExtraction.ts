import OpenAI from 'openai';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { getEnv } from '../config/env.js';
import { trackOpenAiCall } from './aiUsageTelemetry.js';

const receiptExtractionSchema = z.object({
  isReceipt: z.boolean(),
  merchant: z.string().nullable(),
  totalCents: z.number().int().nullable(),
  receiptDate: z.string().nullable(),
  taxCents: z.number().int().nullable(),
  paymentLast4: z.string().nullable(),
  categoryHint: z.string().nullable(),
  categoryEvidence: z.string().nullable(),
  categoryConfidence: z.number().min(0).max(1).nullable(),
  lineItems: z.array(z.object({
    description: z.string(),
    amountCents: z.number().int().nullable(),
  })).default([]),
  confidence: z.number().min(0).max(1),
  notes: z.string().nullable(),
});

export type ReceiptExtraction = z.infer<typeof receiptExtractionSchema>;

export async function extractReceipt(input: {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}): Promise<ReceiptExtraction> {
  const env = getEnv();
  if (!env.OPENAI_API_KEY || !canSendToOpenAI(input)) {
    return fallbackExtraction(input);
  }

  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const response = await trackOpenAiCall(
    'receipt_extraction',
    env.OPENAI_RECEIPT_MODEL,
    () => client.responses.parse({
      model: env.OPENAI_RECEIPT_MODEL,
      input: [{
        role: 'user',
        content: receiptInputContent(input),
      }],
      text: {
        format: zodTextFormat(receiptExtractionSchema, 'receipt_extraction'),
      },
    }),
  );

  const message = response.output.find((item) => item.type === 'message');
  const parsed = message?.content.find((item) => item.type === 'output_text')?.parsed;
  return receiptExtractionSchema.parse(parsed);
}

type ReceiptInputContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail: 'high' }
  | { type: 'input_file'; file_data: string; filename: string; detail: 'high' };

const textInputLimit = 50_000;

function receiptInputContent(input: { buffer: Buffer; mimeType: string; fileName: string }): ReceiptInputContent[] {
  const mimeType = effectiveMimeType(input);
  const instructions: ReceiptInputContent = {
    type: 'input_text',
    text: [
      'Extract receipt and invoice fields for Ledger AI.',
      'Treat receipts, invoices, bills, order confirmations, and payment confirmations as valid business receipt evidence.',
      'Return null for fields that are not visible.',
      'Amounts must be integer cents. receiptDate must be YYYY-MM-DD.',
      'For invoices, use amount due, total, or amount paid as totalCents, preferring the final payable/paid amount.',
      'If visible line items or wording reveals a business expense category, provide a short categoryHint and categoryEvidence.',
      'If this is not receipt or invoice evidence, set isReceipt=false and confidence below 0.5.',
    ].join(' '),
  };

  if (mimeType.startsWith('image/')) {
    return [
      instructions,
      {
        type: 'input_image',
        image_url: `data:${mimeType};base64,${input.buffer.toString('base64')}`,
        detail: 'high',
      },
    ];
  }

  if (isPdf(mimeType, input.fileName)) {
    return [
      instructions,
      {
        type: 'input_file',
        file_data: `data:${mimeType};base64,${input.buffer.toString('base64')}`,
        filename: input.fileName,
        detail: 'high',
      },
    ];
  }

  return [
    instructions,
    {
      type: 'input_text',
      text: [
        `Receipt or invoice text artifact: ${input.fileName}`,
        textFromBuffer(input).slice(0, textInputLimit),
      ].join('\n\n'),
    },
  ];
}

function canSendToOpenAI(input: { mimeType: string; fileName: string }): boolean {
  const mimeType = effectiveMimeType(input);
  return mimeType.startsWith('image/')
    || mimeType === 'application/pdf'
    || mimeType.startsWith('text/');
}

function fallbackExtraction(input: { buffer: Buffer; mimeType: string; fileName: string }): ReceiptExtraction {
  const mimeType = effectiveMimeType(input);
  const text = mimeType.startsWith('text/') ? textFromBuffer({ ...input, mimeType }) : '';
  const normalized = input.fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
  const totalCents = extractTotalCents(text);
  const receiptDate = extractDate(text);
  const merchant = extractMerchant(text) ?? normalized ?? null;
  const confidence = totalCents || receiptDate ? 0.45 : 0.2;
  return {
    isReceipt: true,
    merchant,
    totalCents,
    receiptDate,
    taxCents: null,
    paymentLast4: null,
    categoryHint: null,
    categoryEvidence: null,
    categoryConfidence: null,
    lineItems: [],
    confidence,
    notes: 'Fallback extraction used because OpenAI is not configured or the file type is not supported by the AI extractor.',
  };
}

function textFromBuffer(input: { buffer: Buffer; mimeType: string }): string {
  const text = input.buffer.toString('utf8');
  if (!/html/i.test(input.mimeType)) return text;
  return text
    .replace(/<\s*(script|style)[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|tr|h[1-6]|table)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPdf(mimeType: string, fileName: string): boolean {
  return mimeType === 'application/pdf' || /\.pdf$/i.test(fileName);
}

function effectiveMimeType(input: { mimeType: string; fileName: string }): string {
  if (input.mimeType !== 'application/octet-stream') return input.mimeType;
  if (/\.pdf$/i.test(input.fileName)) return 'application/pdf';
  if (/\.png$/i.test(input.fileName)) return 'image/png';
  if (/\.jpe?g$/i.test(input.fileName)) return 'image/jpeg';
  if (/\.webp$/i.test(input.fileName)) return 'image/webp';
  if (/\.txt$/i.test(input.fileName)) return 'text/plain';
  if (/\.html?$/i.test(input.fileName)) return 'text/html';
  return input.mimeType;
}

function extractTotalCents(text: string): number | null {
  if (!text) return null;
  const lines = text.split(/\n+/);
  const preferred = lines.find((line) => /\b(total|amount paid|amount due|balance due|grand total|charged)\b/i.test(line)
    && moneyPattern().test(line));
  const match = (preferred ?? text).match(moneyPattern());
  return match ? moneyToCents(match[0]) : null;
}

function extractDate(text: string): string | null {
  const iso = text.match(/\b(20\d{2})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/);
  if (iso) return formatDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const slash = text.match(/\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(20\d{2}|\d{2})\b/);
  if (slash) {
    const year = Number(slash[3].length === 2 ? `20${slash[3]}` : slash[3]);
    return formatDate(year, Number(slash[1]), Number(slash[2]));
  }

  const named = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+([0-3]?\d),?\s+(20\d{2})\b/i);
  if (named) return formatDate(Number(named[3]), monthNumber(named[1]), Number(named[2]));
  return null;
}

function extractMerchant(text: string): string | null {
  const subject = text.match(/^Subject:\s*(.+)$/im)?.[1];
  if (subject) {
    const cleaned = subject
      .replace(/^(fwd?|re):\s*/i, '')
      .replace(/\b(receipt|invoice|order confirmation|payment received|your order)\b/gi, '')
      .replace(/^\s*(from|for)\s+/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (cleaned.length >= 2) return cleaned.slice(0, 80);
  }

  const from = text.match(/^From:\s*(.+)$/im)?.[1];
  if (!from) return null;
  const displayName = from.match(/^"?([^"<]+)"?\s*</)?.[1]?.trim();
  return (displayName || from.replace(/<[^>]+>/g, '').trim()).slice(0, 80) || null;
}

function moneyPattern(): RegExp {
  return /[$€£]\s?-?\d[\d,]*(?:\.\d{2})?/i;
}

function moneyToCents(value: string): number | null {
  const normalized = value.replace(/[^0-9.-]/g, '');
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return null;
  return Math.round(Math.abs(amount) * 100);
}

function formatDate(year: number, month: number, day: number): string | null {
  if (!year || !month || !day) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function monthNumber(value: string): number {
  return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    .findIndex((month) => value.toLowerCase().startsWith(month)) + 1;
}
