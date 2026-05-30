import { useEffect, useMemo, useState } from 'react';
import { Download, ExternalLink, FileQuestion, FileText, Loader2 } from 'lucide-react';
import { fetchReceiptFileText, receiptFileUrl } from '@/api';
import type { ReceiptInboxItem } from '@/types/domain';
import { cn } from '@/lib/cn';
import { receiptPreviewKind } from '@/lib/receiptPreview';
import { Button } from '@/components/ui/button';

interface Props {
  receipt: ReceiptInboxItem;
  className?: string;
}

export function ReceiptPreview({ receipt, className }: Props) {
  const kind = receiptPreviewKind(receipt.mimeType, receipt.fileName);
  const inlineUrl = useMemo(() => receiptFileUrl(receipt.id), [receipt.id]);
  const downloadUrl = useMemo(() => receiptFileUrl(receipt.id, { download: true }), [receipt.id]);
  const [text, setText] = useState('');
  const [loadingText, setLoadingText] = useState(false);
  const [textError, setTextError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setText('');
    setTextError('');
    if (kind !== 'text') {
      setLoadingText(false);
      return;
    }

    setLoadingText(true);
    fetchReceiptFileText(receipt.id)
      .then((value) => {
        if (!cancelled) setText(value);
      })
      .catch((error: Error) => {
        if (!cancelled) setTextError(error.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingText(false);
      });

    return () => {
      cancelled = true;
    };
  }, [kind, receipt.id]);

  return (
    <section className={cn('flex min-h-[420px] flex-col bg-[hsl(var(--color-sunken))]', className)}>
      <div className="flex items-center gap-2 border-b border-ink2/10 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-dim">Preview</div>
          <div className="truncate text-sm font-bold text-ink" title={receipt.fileName ?? undefined}>
            {receipt.fileName ?? 'Receipt file'}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => window.open(inlineUrl, '_blank', 'noopener,noreferrer')}>
          <ExternalLink className="h-4 w-4" />
          Open
        </Button>
        <Button asChild variant="outline" size="icon-sm" title="Download receipt">
          <a href={downloadUrl} download>
            <Download className="h-4 w-4" />
            <span className="sr-only">Download receipt</span>
          </a>
        </Button>
      </div>
      <div className="min-h-0 flex-1 p-3">
        <PreviewBody
          kind={kind}
          inlineUrl={inlineUrl}
          text={text}
          textError={textError}
          loadingText={loadingText}
          fileName={receipt.fileName}
        />
      </div>
    </section>
  );
}

function PreviewBody({
  kind,
  inlineUrl,
  text,
  textError,
  loadingText,
  fileName,
}: {
  kind: ReturnType<typeof receiptPreviewKind>;
  inlineUrl: string;
  text: string;
  textError: string;
  loadingText: boolean;
  fileName?: string | null;
}) {
  if (kind === 'pdf') {
    return (
      <iframe
        title={fileName ?? 'Receipt PDF'}
        src={inlineUrl}
        className="h-[560px] w-full rounded-md border border-ink2/10 bg-white lg:h-full"
      />
    );
  }

  if (kind === 'image') {
    return (
      <div className="flex h-[560px] items-center justify-center overflow-auto rounded-md border border-ink2/10 bg-white p-3 lg:h-full">
        <img src={inlineUrl} alt={fileName ?? 'Receipt'} className="max-h-full max-w-full object-contain" />
      </div>
    );
  }

  if (kind === 'html') {
    return (
      <iframe
        title={fileName ?? 'Receipt HTML'}
        src={inlineUrl}
        sandbox=""
        className="h-[560px] w-full rounded-md border border-ink2/10 bg-white lg:h-full"
      />
    );
  }

  if (kind === 'text') {
    return (
      <div className="h-[560px] overflow-auto rounded-md border border-ink2/10 bg-white p-3 lg:h-full">
        {loadingText ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-dim">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading preview
          </div>
        ) : textError ? (
          <PreviewFallback title="Preview unavailable" detail={textError} />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-ink">{text}</pre>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-[560px] items-center justify-center rounded-md border border-dashed border-ink2/20 bg-white p-6 text-center lg:h-full">
      <PreviewFallback
        title="Preview unavailable"
        detail="This file type cannot be rendered in the browser."
      />
    </div>
  );
}

function PreviewFallback({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="mx-auto grid max-w-sm justify-items-center gap-2">
      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-cream text-ink">
        {title === 'Preview unavailable' ? <FileQuestion className="h-5 w-5" /> : <FileText className="h-5 w-5" />}
      </span>
      <div className="font-bold text-ink">{title}</div>
      <div className="text-sm text-dim">{detail}</div>
    </div>
  );
}
