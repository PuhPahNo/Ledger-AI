import { useState } from 'react';
import { Plus, Save } from 'lucide-react';
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

const EMPTY_FORM = { key: '', name: '', short: '', color: '#D97757', hue: 24 };

export function BusinessesTab({ data, saveAndRefresh }: Props) {
  const [form, setForm] = useState(EMPTY_FORM);
  // Businesses are set up once; keep the form out of the way until it's asked for.
  const [adding, setAdding] = useState(data.businesses.length === 0);

  const create = async () => {
    const ok = await saveAndRefresh(() => createBusiness({ ...form, key: form.key || undefined }), 'Business created.');
    if (!ok) return;
    setForm(EMPTY_FORM);
    setAdding(false);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="grid gap-1.5">
          <CardTitle>Businesses</CardTitle>
          <CardDescription>
            {data.businesses.length} business{data.businesses.length === 1 ? '' : 'es'}, each with its own ledger, color and short code.
          </CardDescription>
        </div>
        {!adding && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Add business
          </Button>
        )}
      </CardHeader>
      <CardContent className="grid gap-3">
        {adding && (
          <div className="grid gap-3 rounded-xl border border-ink2/10 bg-cream/40 p-4 sm:grid-cols-2">
            <FieldText label="Name" value={form.name} onChange={(name) => setForm({ ...form, name })} />
            <FieldText label="Short code" value={form.short} onChange={(short) => setForm({ ...form, short })} />
            <FieldText label="URL key" value={form.key} onChange={(key) => setForm({ ...form, key })} placeholder="auto from name" />
            <FieldColor label="Brand color" value={form.color} onChange={(color) => setForm({ ...form, color })} />
            <div className="flex gap-2 sm:col-span-2 sm:justify-end">
              {data.businesses.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => { setForm(EMPTY_FORM); setAdding(false); }}>
                  Cancel
                </Button>
              )}
              <Button size="sm" onClick={create} disabled={!form.name.trim()}>
                <Save className="h-3.5 w-3.5" /> Create business
              </Button>
            </div>
          </div>
        )}
        {data.businesses.length ? (
          data.businesses.map((business) => (
            <EditableBusiness
              key={business.id}
              business={business}
              onSave={(body) => saveAndRefresh(() => updateBusiness(business.id, body), 'Business saved.')}
            />
          ))
        ) : (
          !adding && <EmptyState title="No businesses yet" description="Add your first business to start tracking spend." />
        )}
      </CardContent>
    </Card>
  );
}
