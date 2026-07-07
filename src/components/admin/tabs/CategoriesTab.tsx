import { useState } from 'react';
import { createCategory, updateCategory, type AdminOverview } from '@/api';
import type { Business } from '@/types/domain';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { FieldBusiness, FieldColor, FieldText, type SaveAndRefresh } from '../fields';
import { EditableCategory } from '../rows/EditableCategory';

interface Props {
  data: AdminOverview;
  businesses: Business[];
  saveAndRefresh: SaveAndRefresh;
}

export function CategoriesTab({ data, businesses, saveAndRefresh }: Props) {
  const [categoryForm, setCategoryForm] = useState({ name: '', taxCode: '', color: '#D97757', businessId: '' });

  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <Card className="lg:col-span-4">
        <CardHeader>
          <CardTitle>Create category</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <FieldBusiness
            label="Scope"
            value={categoryForm.businessId}
            businesses={businesses}
            onChange={(businessId) => setCategoryForm({ ...categoryForm, businessId })}
          />
          <FieldText label="Name" value={categoryForm.name} onChange={(name) => setCategoryForm({ ...categoryForm, name })} />
          <FieldText label="Tax code" value={categoryForm.taxCode} onChange={(taxCode) => setCategoryForm({ ...categoryForm, taxCode })} />
          <FieldColor label="Color" value={categoryForm.color} onChange={(color) => setCategoryForm({ ...categoryForm, color })} />
          <Button
            onClick={() =>
              saveAndRefresh(
                () => createCategory({ ...categoryForm, businessId: categoryForm.businessId || null }),
                'Category created.',
              )
            }
          >
            Create category
          </Button>
        </CardContent>
      </Card>

      <Card className="lg:col-span-8">
        <CardHeader>
          <CardTitle>Categories</CardTitle>
          <CardDescription>{data.categories.length} defined.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2">
            {data.categories.length ? (
              data.categories.map((category) => (
                <EditableCategory
                  key={category.id}
                  category={category}
                  onSave={(body) => saveAndRefresh(() => updateCategory(category.id, body), 'Category saved.')}
                />
              ))
            ) : (
              <EmptyState title="No categories" description="Create your first category to start grouping spend." />
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
