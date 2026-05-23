import { useRef, useState } from 'react';
import { colors, fonts } from '@/theme/tokens';
import { Tile } from './Tile';

interface Props {
  onFile: (file: File) => void;
}

export function ReceiptDropTile({ onFile }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);

  return (
    <Tile
      bg={colors.plum}
      ink={colors.cream}
      colSpan={3}
      rowSpan={1}
      pad={14}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        outline: dragOver ? `2px solid ${colors.lemon}` : 'none',
        transition: 'outline 120ms ease',
      }}
    >
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
        style={{
          width: 48,
          height: 48,
          borderRadius: 12,
          background: 'rgba(255,255,255,0.08)',
          border: '2px dashed rgba(255,255,255,0.3)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={colors.cream} strokeWidth="1.6" strokeLinecap="round">
          <path d="M12 16V4M12 4l-4 4M12 4l4 4M4 20h16" />
        </svg>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: fonts.display, fontSize: 16, fontWeight: 600, letterSpacing: -0.3 }}>
          Snap or drop a receipt
        </div>
        <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>
          We'll OCR it and try to match the transaction automatically.
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

      <div style={{ display: 'flex', gap: 6 }}>
        <PrimaryButton onClick={() => cameraInput.current?.click()}>Camera</PrimaryButton>
        <SecondaryButton onClick={() => fileInput.current?.click()}>Browse</SecondaryButton>
        <SecondaryButton onClick={() => void pasteFromClipboard().then((f) => f && onFile(f))}>Paste</SecondaryButton>
      </div>
    </Tile>
  );
}

function PrimaryButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '7px 12px',
        borderRadius: 99,
        background: colors.lemon,
        color: colors.lemonInk,
        border: 'none',
        fontWeight: 600,
        fontSize: 11.5,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function SecondaryButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '7px 12px',
        borderRadius: 99,
        background: 'rgba(255,255,255,0.08)',
        color: colors.cream,
        border: '1px solid rgba(255,255,255,0.15)',
        fontWeight: 600,
        fontSize: 11.5,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
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
