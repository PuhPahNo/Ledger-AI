import OpenAI from 'openai';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { getEnv } from '../config/env.js';

const receiptExtractionSchema = z.object({
  isReceipt: z.boolean(),
  merchant: z.string().nullable(),
  totalCents: z.number().int().nullable(),
  receiptDate: z.string().nullable(),
  taxCents: z.number().int().nullable(),
  paymentLast4: z.string().nullable(),
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
  if (!env.OPENAI_API_KEY || !input.mimeType.startsWith('image/')) {
    return fallbackExtraction(input.fileName);
  }

  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const base64 = input.buffer.toString('base64');
  const response = await client.responses.parse({
    model: env.OPENAI_RECEIPT_MODEL,
    input: [{
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: [
            'Extract receipt fields for Ledger AI.',
            'Return null for fields that are not visible.',
            'Amounts must be integer cents. receiptDate must be YYYY-MM-DD.',
            'If this is not a business receipt, set isReceipt=false and confidence below 0.5.',
          ].join(' '),
        },
        {
          type: 'input_image',
          image_url: `data:${input.mimeType};base64,${base64}`,
          detail: 'high',
        },
      ],
    }],
    text: {
      format: zodTextFormat(receiptExtractionSchema, 'receipt_extraction'),
    },
  });

  const message = response.output.find((item) => item.type === 'message');
  const parsed = message?.content.find((item) => item.type === 'output_text')?.parsed;
  return receiptExtractionSchema.parse(parsed);
}

function fallbackExtraction(fileName: string): ReceiptExtraction {
  const normalized = fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
  return {
    isReceipt: true,
    merchant: normalized || null,
    totalCents: null,
    receiptDate: null,
    taxCents: null,
    paymentLast4: null,
    confidence: 0.2,
    notes: 'Fallback extraction used because OpenAI is not configured or the file is not an image.',
  };
}
