import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import {
  createAdminUser,
  resetAdminUserPassword,
  setAdminUserActive,
  updateAdminUser,
  type AdminOverview,
} from '@/api';
import type { CurrentUser } from '@/types/domain';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/useToast';
import { FieldText, type SaveAndRefresh } from '../fields';
import { EditableUser } from '../rows/EditableUser';

interface Props {
  data: AdminOverview;
  user?: CurrentUser;
  saveAndRefresh: SaveAndRefresh;
}

export function UsersTab({ data, user, saveAndRefresh }: Props) {
  const { toast } = useToast();
  const [form, setForm] = useState({ username: '', displayName: '', password: '' });

  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <Card className="lg:col-span-4">
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
    </div>
  );
}
