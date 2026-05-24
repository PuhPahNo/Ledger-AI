import { useState } from 'react';
import { Save } from 'lucide-react';
import { createBusiness, updateBusiness, type AdminOverview } from '@/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { FieldColor, FieldText, type SaveAndRefresh } from '../fields';
import { EditableBusiness } from '../rows/EditableBusiness';

interface Props {
  data: AdminOverview;
  saveAndRefresh: SaveAndRefresh;
}

export function BusinessesTab({ data, saveAndRefresh }: Props) {
  const [form, setForm] = useState({ key: '', name: '', short: '', color: '#D97757', hue: 24 });

  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <Card className="lg:col-span-4">
        <CardHeader>
          <CardTitle>Create business</CardTitle>
          <CardDescription>Each business gets its own ledger, color, and short code.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <FieldText label="Name" value={form.name} onChange={(name) => setForm({ ...form, name })} />
          <FieldText label="Short code" value={form.short} onChange={(short) => setForm({ ...form, short })} />
          <FieldText label="URL key" value={form.key} onChange={(key) => setForm({ ...form, key })} placeholder="auto from name" />
          <FieldColor label="Brand color" value={form.color} onChange={(color) => setForm({ ...form, color })} />
          <Button
            onClick={() =>
              saveAndRefresh(() => createBusiness({ ...form, key: form.key || undefined }), 'Business created.')
            }
          >
            <Save className="h-3.5 w-3.5" /> Create business
          </Button>
        </CardContent>
      </Card>

      <Card className="lg:col-span-8">
        <CardHeader>
          <CardTitle>Business directory</CardTitle>
          <CardDescription>
            {data.businesses.length} workspace{data.businesses.length === 1 ? '' : 's'}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2">
            {data.businesses.length ? (
              data.businesses.map((business) => (
                <EditableBusiness
                  key={business.id}
                  business={business}
                  onSave={(body) => saveAndRefresh(() => updateBusiness(business.id, body), 'Business saved.')}
                />
              ))
            ) : (
              <EmptyState title="No businesses yet" description="Create your first business to start tracking spend." />
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
