import { useRef, useState } from 'react';
import { Camera, ClipboardPaste, FolderOpen, Upload } from 'lucide-react';
import { Tile } from '@/components/ui/tile';
import { Button } from '@/components/ui/button';
import { StatLabel } from '@/components/ui/stat-label';
import { cn } from '@/lib/cn';

interface Props {
  onFile: (file: File) => void;
  status?: {
    state: 'idle' | 'uploading' | 'processing' | 'matched' | 'pending' | 'error';
    message?: string;
  };
}

export function ReceiptDropTile({ onFile, status = { state: 'idle' } }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);

  return (
    <Tile
      tone="plum"
      pad="md"
      colSpan={4}
      rowSpan={3}
      className={cn(
        'gap-4 transition-all',
        dragOver && 'ring-2 ring-lemon ring-offset-2 ring-offset-bg',
      )}
    >
      <div className="flex items-baseline gap-2">
        <StatLabel className="text-cream/70">RECEIPTS</StatLabel>
        {status.state !== 'idle' && (
          <span className="ml-auto rounded-full bg-cream/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-cream/80">
            {status.state}
          </span>
        )}
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
        onClick={() => fileInput.current?.click()}
        className={cn(
          'group flex flex-1 cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-6 text-center transition-colors',
          dragOver ? 'border-lemon bg-lemon/10' : 'border-cream/25 bg-cream/5 hover:bg-cream/10',
        )}
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-cream/15 text-cream transition-transform group-hover:scale-105">
          <Upload className="h-6 w-6" />
        </div>
        <div className="font-display text-lg font-bold leading-tight text-cream">
          {titleFor(status.state)}
        </div>
        <div className="text-xs leading-relaxed text-cream/70">
          {status.message ?? "Drop a file, paste from clipboard, or use the buttons below. We'll OCR and try to match it automatically."}
        </div>
      </div>

      <input
        ref={cameraInput}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
      <input
        ref={fileInput}
        type="file"
        accept="image/*,application/pdf"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />

      <div className="grid grid-cols-3 gap-2">
        <Button variant="accent" size="sm" onClick={() => cameraInput.current?.click()}>
          <Camera className="h-4 w-4" />
          Camera
        </Button>
        <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()} className="border-cream/30 text-cream hover:bg-cream/10">
          <FolderOpen className="h-4 w-4" />
          Browse
        </Button>
        <Button variant="outline" size="sm" onClick={() => void pasteFromClipboard().then((f) => f && onFile(f))} className="border-cream/30 text-cream hover:bg-cream/10">
          <ClipboardPaste className="h-4 w-4" />
          Paste
        </Button>
      </div>
    </Tile>
  );
}

function titleFor(state: NonNullable<Props['status']>['state']) {
  switch (state) {
    case 'uploading':
      return 'Uploading receipt…';
    case 'processing':
      return 'Receipt is processing';
    case 'matched':
      return 'Receipt matched';
    case 'pending':
      return 'Needs match review';
    case 'error':
      return 'Receipt upload failed';
    default:
      return 'Drop a receipt';
  }
}

async function pasteFromClipboard(): Promise<File | null> {
  if (!navigator.clipboard?.read) return null;
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imageType = item.types.find((t) => t.startsWith('image/'));
      if (imageType) {
        const blob = await item.getType(imageType);
        return new File([blob], `pasted-receipt.${imageType.split('/')[1]}`, { type: imageType });
      }
    }
  } catch {
    // Clipboard permission denied or not an image — silently no-op.
  }
  return null;
}
