import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Tiny markdown subset renderer for assistant prose: paragraphs, bullet and numbered lists,
 * short headings, **bold**, *italic* and `code`. Everything renders as React text nodes, so
 * model output can never inject HTML (no dangerouslySetInnerHTML anywhere).
 */
export function RichText({ text, invert = false }: { text: string; invert?: boolean }) {
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  return (
    <div className={cn('space-y-2 text-sm leading-relaxed', invert ? 'text-strong-foreground' : 'text-ink')}>
      {blocks.map((block, index) => renderBlock(block, index))}
    </div>
  );
}

function renderBlock(block: string, key: number): ReactNode {
  const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 1) {
    const heading = /^#{1,4}\s+(.*)$/.exec(lines[0]);
    if (heading) return <p key={key} className="font-display font-bold">{inline(heading[1])}</p>;
  }
  if (lines.every((line) => /^[-*•]\s+/.test(line))) {
    return (
      <ul key={key} className="list-disc space-y-1 pl-5">
        {lines.map((line, index) => <li key={index}>{inline(line.replace(/^[-*•]\s+/, ''))}</li>)}
      </ul>
    );
  }
  if (lines.every((line) => /^\d+[.)]\s+/.test(line))) {
    return (
      <ol key={key} className="list-decimal space-y-1 pl-5">
        {lines.map((line, index) => <li key={index}>{inline(line.replace(/^\d+[.)]\s+/, ''))}</li>)}
      </ol>
    );
  }
  return (
    <p key={key}>
      {lines.map((line, index) => (
        <span key={index}>
          {index > 0 && <br />}
          {inline(line)}
        </span>
      ))}
    </p>
  );
}

export function inline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      return <code key={index} className="rounded bg-ink2/10 px-1 font-mono text-[0.9em]">{part.slice(1, -1)}</code>;
    }
    if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) return <em key={index}>{part.slice(1, -1)}</em>;
    return <span key={index}>{part}</span>;
  });
}
