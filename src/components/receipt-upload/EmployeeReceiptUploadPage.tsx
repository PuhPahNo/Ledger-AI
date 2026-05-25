import { useEffect, useRef, useState } from 'react';
import { Camera, CheckCircle2, ClipboardPaste, FileUp, LogOut, ReceiptText, RotateCcw, ShieldCheck, Upload, XCircle } from 'lucide-react';
import {
  getReceiptUploaderSession,
  loginReceiptUploader,
  logoutReceiptUploader,
  uploadEmployeeReceipt,
  type EmployeeReceiptUploadResult,
  type ReceiptUploaderSessionUser,
} from '@/api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/cn';

const acceptedReceiptTypes = 'image/*,application/pdf,text/plain,text/html,.txt,.html,.htm';

type UploadState =
  | { state: 'idle' }
  | { state: 'uploading'; fileName: string }
  | { state: 'success'; result: EmployeeReceiptUploadResult; fileName: string }
  | { state: 'error'; message: string };

export function EmployeeReceiptUploadPage() {
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const [checking, setChecking] = useState(true);
  const [uploader, setUploader] = useState<ReceiptUploaderSessionUser | null>(null);
  const [credentials, setCredentials] = useState({ username: '', password: '' });
  const [loginError, setLoginError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [uploadState, setUploadState] = useState<UploadState>({ state: 'idle' });

  useEffect(() => {
    getReceiptUploaderSession()
      .then((result) => setUploader(result.uploader))
      .catch(() => setUploader(null))
      .finally(() => setChecking(false));
  }, []);

  const login = async () => {
    setLoginError('');
    try {
      const result = await loginReceiptUploader(credentials.username, credentials.password);
      setUploader(result.uploader);
      setCredentials({ username: '', password: '' });
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Login failed.');
    }
  };

  const logout = async () => {
    await logoutReceiptUploader();
    setUploader(null);
    setUploadState({ state: 'idle' });
  };

  const upload = async (file: File | null | undefined) => {
    if (!file) return;
    setUploadState({ state: 'uploading', fileName: file.name });
    try {
      const result = await uploadEmployeeReceipt(file);
      setUploadState({ state: 'success', result, fileName: file.name });
    } catch (error) {
      setUploadState({ state: 'error', message: error instanceof Error ? error.message : 'Upload failed.' });
    }
  };

  if (checking) return <div className="min-h-screen bg-bg" />;

  return (
    <main className="min-h-screen bg-bg text-ink">
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col px-4 py-5 sm:justify-center">
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-ink text-lemon">
              <ReceiptText className="h-5 w-5" />
            </span>
            <div>
              <h1 className="font-display text-2xl font-bold leading-tight">Receipt Upload</h1>
              <p className="text-sm text-dim">Ledger AI</p>
            </div>
          </div>
          {uploader && (
            <Button variant="ghost" size="icon" onClick={logout} title="Sign out">
              <LogOut className="h-4 w-4" />
            </Button>
          )}
        </div>

        {!uploader ? (
          <section className="rounded-lg border border-ink2/10 bg-paper p-4 shadow-sm">
            <div className="mb-4 flex items-center gap-2 text-sm font-bold text-ink">
              <ShieldCheck className="h-4 w-4 text-sage-ink" />
              Employee access
            </div>
            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void login();
              }}
            >
              <div className="grid gap-1.5">
                <Label htmlFor="receipt-uploader-username">Username</Label>
                <Input
                  id="receipt-uploader-username"
                  autoComplete="username"
                  value={credentials.username}
                  onChange={(event) => setCredentials({ ...credentials, username: event.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="receipt-uploader-password">Password</Label>
                <Input
                  id="receipt-uploader-password"
                  type="password"
                  autoComplete="current-password"
                  value={credentials.password}
                  onChange={(event) => setCredentials({ ...credentials, password: event.target.value })}
                />
              </div>
              {loginError && (
                <Alert variant="destructive">
                  <XCircle className="h-4 w-4" />
                  <AlertTitle>Could not sign in</AlertTitle>
                  <AlertDescription>{loginError}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" size="lg" disabled={!credentials.username || !credentials.password}>
                Continue
              </Button>
            </form>
          </section>
        ) : (
          <section className="grid gap-4">
            <div className="rounded-lg border border-ink2/10 bg-paper p-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold">{uploader.displayName}</p>
                  <p className="truncate text-xs text-dim">{uploader.businessName ?? 'Receipt uploader'}</p>
                </div>
                <span className="rounded-full bg-sage/50 px-2.5 py-1 text-xs font-bold text-sage-ink">Signed in</span>
              </div>
            </div>

            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragOver(false);
                void upload(event.dataTransfer.files?.[0]);
              }}
              className={cn(
                'grid min-h-[18rem] place-items-center rounded-lg border-2 border-dashed bg-paper p-6 text-center shadow-sm transition-colors',
                dragOver ? 'border-lemon bg-lemon/15' : 'border-ink2/20',
              )}
            >
              <div className="grid gap-4">
                <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-lemon text-lemon-ink">
                  <Upload className="h-7 w-7" />
                </span>
                <div>
                  <h2 className="font-display text-2xl font-bold leading-tight">{uploadTitle(uploadState)}</h2>
                  <p className="mt-1 text-sm text-dim">{uploadDetail(uploadState)}</p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button size="lg" onClick={() => cameraInput.current?.click()}>
                    <Camera className="h-4 w-4" />
                    Camera
                  </Button>
                  <Button variant="outline" size="lg" onClick={() => fileInput.current?.click()}>
                    <FileUp className="h-4 w-4" />
                    Files
                  </Button>
                </div>
                <Button variant="ghost" onClick={() => void pasteFromClipboard().then(upload)}>
                  <ClipboardPaste className="h-4 w-4" />
                  Paste image
                </Button>
              </div>
            </div>

            {uploadState.state === 'success' && (
              <Alert variant={uploadState.result.duplicate ? 'warning' : 'success'}>
                {uploadState.result.duplicate ? <RotateCcw className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                <AlertTitle>{uploadState.result.duplicate ? 'Already uploaded' : 'Receipt received'}</AlertTitle>
                <AlertDescription>
                  {uploadState.result.message ?? (uploadState.result.duplicate ? 'This file matches an earlier upload.' : 'Ledger AI is scanning and matching it.')}
                </AlertDescription>
              </Alert>
            )}

            {uploadState.state === 'error' && (
              <Alert variant="destructive">
                <XCircle className="h-4 w-4" />
                <AlertTitle>Upload failed</AlertTitle>
                <AlertDescription>{uploadState.message}</AlertDescription>
              </Alert>
            )}

            <input
              ref={cameraInput}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(event) => {
                void upload(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <input
              ref={fileInput}
              type="file"
              accept={acceptedReceiptTypes}
              hidden
              onChange={(event) => {
                void upload(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </section>
        )}
      </div>
    </main>
  );
}

function uploadTitle(uploadState: UploadState): string {
  if (uploadState.state === 'uploading') return 'Uploading';
  if (uploadState.state === 'success') return uploadState.result.duplicate ? 'Duplicate found' : 'Uploaded';
  if (uploadState.state === 'error') return 'Try again';
  return 'Add receipt';
}

function uploadDetail(uploadState: UploadState): string {
  if (uploadState.state === 'uploading') return uploadState.fileName;
  if (uploadState.state === 'success') return uploadState.fileName;
  if (uploadState.state === 'error') return uploadState.message;
  return 'Photo, PDF, image, text, or HTML';
}

async function pasteFromClipboard(): Promise<File | null> {
  if (!navigator.clipboard?.read) return null;
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imageType = item.types.find((type) => type.startsWith('image/'));
      if (imageType) {
        const blob = await item.getType(imageType);
        return new File([blob], `pasted-receipt.${imageType.split('/')[1]}`, { type: imageType });
      }
    }
  } catch {
    // Clipboard permission denied or unsupported.
  }
  return null;
}
