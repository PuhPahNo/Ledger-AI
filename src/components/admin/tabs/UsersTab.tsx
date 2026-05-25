import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import {
  createAdminUser,
  createReceiptUploader,
  deleteReceiptUploader,
  resetAdminUserPassword,
  resetReceiptUploaderPassword,
  setAdminUserActive,
  updateAdminUser,
  updateReceiptUploader,
  type AdminOverview,
} from '@/api';
import type { Business, CurrentUser } from '@/types/domain';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/useToast';
import { FieldText, type SaveAndRefresh } from '../fields';
import { FieldBusiness } from '../fields';
import { EditableReceiptUploader } from '../rows/EditableReceiptUploader';
import { EditableUser } from '../rows/EditableUser';

interface Props {
  data: AdminOverview;
  businesses: Business[];
  user?: CurrentUser;
  saveAndRefresh: SaveAndRefresh;
}

export function UsersTab({ data, businesses, user, saveAndRefresh }: Props) {
  const { toast } = useToast();
  const [form, setForm] = useState({ username: '', displayName: '', password: '' });
  const [uploaderForm, setUploaderForm] = useState({ username: '', displayName: '', password: '', businessId: '' });
  const canCreateUploader = uploaderForm.username.trim().length >= 2
    && uploaderForm.displayName.trim().length > 0
    && uploaderForm.password.length >= 8;

  const createUploader = async () => {
    if (!canCreateUploader) {
      toast({
        variant: 'destructive',
        title: 'Uploader details incomplete',
        description: 'Use a username, display name, and password with at least 8 characters.',
      });
      return;
    }
    const saved = await saveAndRefresh(
      () => createReceiptUploader({
        ...uploaderForm,
        username: uploaderForm.username.trim(),
        displayName: uploaderForm.displayName.trim(),
        businessId: uploaderForm.businessId || null,
      }),
      'Uploader created.',
    );
    if (saved) setUploaderForm({ username: '', displayName: '', password: '', businessId: '' });
  };

  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <div className="grid gap-4 lg:col-span-4">
        <Card>
          <CardHeader>
            <CardTitle>Invite admin</CardTitle>
            <CardDescription>Admins can read every business and edit settings.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <FieldText label="Username" value={form.username} onChange={(username) => setForm({ ...form, username })} />
            <FieldText label="Display name" value={form.displayName} onChange={(displayName) => setForm({ ...form, displayName })} />
            <FieldText label="Password" type="password" value={form.password} onChange={(password) => setForm({ ...form, password })} placeholder="12+ characters" />
            <Button onClick={() => saveAndRefresh(() => createAdminUser(form), 'Admin created.')}>
              <UserPlus className="h-3.5 w-3.5" /> Create admin
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Create uploader</CardTitle>
            <CardDescription>Uploaders can only send receipt files through the mobile portal.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <FieldText label="Username" value={uploaderForm.username} onChange={(username) => setUploaderForm({ ...uploaderForm, username })} />
            <FieldText label="Display name" value={uploaderForm.displayName} onChange={(displayName) => setUploaderForm({ ...uploaderForm, displayName })} />
            <FieldBusiness label="Business" value={uploaderForm.businessId} businesses={businesses} onChange={(businessId) => setUploaderForm({ ...uploaderForm, businessId })} />
            <FieldText label="Password" type="password" value={uploaderForm.password} onChange={(password) => setUploaderForm({ ...uploaderForm, password })} placeholder="8+ characters" />
            <Button
              onClick={createUploader}
              disabled={!canCreateUploader}
            >
              <UserPlus className="h-3.5 w-3.5" /> Create uploader
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card className="lg:col-span-8">
        <CardHeader>
          <CardTitle>Admin accounts</CardTitle>
          <CardDescription>{data.users.length} active.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2">
            {data.users.map((admin) => (
              <EditableUser
                key={admin.id}
                admin={admin}
                onSave={(body) => saveAndRefresh(() => updateAdminUser(admin.id, body), 'Admin saved.')}
                onPassword={(password) => {
                  if (password.length < 12) {
                    toast({ variant: 'destructive', title: 'Password too short', description: 'Use at least 12 characters.' });
                    return Promise.resolve(false);
                  }
                  return saveAndRefresh(
                    () => resetAdminUserPassword(admin.id, password),
                    admin.id === user?.id ? 'Password reset. Use it next time you log in.' : 'Password reset.',
                  );
                }}
                onActive={(active) =>
                  saveAndRefresh(
                    () => setAdminUserActive(admin.id, active),
                    active ? 'Admin activated.' : 'Admin deactivated.',
                  )
                }
              />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-12">
        <CardHeader>
          <CardTitle>Receipt uploaders</CardTitle>
          <CardDescription>{data.receiptUploaders.filter((uploader) => uploader.active).length} active.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 lg:grid-cols-2">
            {data.receiptUploaders.map((uploader) => (
              <EditableReceiptUploader
                key={uploader.id}
                uploader={uploader}
                businesses={businesses}
                onSave={(body) => saveAndRefresh(() => updateReceiptUploader(uploader.id, body), 'Uploader saved.')}
                onPassword={(password) => {
                  if (password.length < 8) {
                    toast({ variant: 'destructive', title: 'Password too short', description: 'Use at least 8 characters.' });
                    return Promise.resolve(false);
                  }
                  return saveAndRefresh(() => resetReceiptUploaderPassword(uploader.id, password), 'Uploader password reset.');
                }}
                onDelete={() => saveAndRefresh(() => deleteReceiptUploader(uploader.id), 'Uploader deleted.')}
              />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
