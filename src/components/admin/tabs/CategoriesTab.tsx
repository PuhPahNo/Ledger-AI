import { useState } from 'react';
import {
  createCategory,
  createCategoryRule,
  updateCategory,
  updateCategoryRule,
  type AdminOverview,
} from '@/api';
import type { Business } from '@/types/domain';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { FieldBusiness, FieldColor, FieldSelect, FieldText, type SaveAndRefresh } from '../fields';
import { EditableCategory } from '../rows/EditableCategory';
import { EditableRule } from '../rows/EditableRule';

interface Props {
  data: AdminOverview;
  businesses: Business[];
  saveAndRefresh: SaveAndRefresh;
}

const MATCH_KINDS = [
  { value: 'merchant_contains', label: 'Merchant contains' },
  { value: 'merchant_exact', label: 'Merchant exact' },
  { value: 'plaid_category', label: 'Plaid category' },
  { value: 'amount_range', label: 'Amount range' },
];

export function CategoriesTab({ data, businesses, saveAndRefresh }: Props) {
  const [categoryForm, setCategoryForm] = useState({ name: '', taxCode: '', color: '#D97757', businessId: '' });
  const [ruleForm, setRuleForm] = useState({
    categoryId: '',
    businessId: '',
    matchKind: 'merchant_contains',
    pattern: '',
    priority: 100,
  });

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

      <Card className="lg:col-span-4">
        <CardHeader>
          <CardTitle>Create rule</CardTitle>
          <CardDescription>Automatically tag transactions that match a pattern.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <FieldBusiness
            label="Scope"
            value={ruleForm.businessId}
            businesses={businesses}
            onChange={(businessId) => setRuleForm({ ...ruleForm, businessId })}
          />
          <FieldSelect
            label="Category"
            value={ruleForm.categoryId}
            onChange={(categoryId) => setRuleForm({ ...ruleForm, categoryId })}
            placeholder="Choose"
            options={data.categories.map((category) => ({ value: category.id, label: category.name }))}
          />
          <FieldSelect
            label="Match"
            value={ruleForm.matchKind}
            onChange={(matchKind) => setRuleForm({ ...ruleForm, matchKind })}
            options={MATCH_KINDS}
          />
          <FieldText label="Pattern" value={ruleForm.pattern} onChange={(pattern) => setRuleForm({ ...ruleForm, pattern })} />
          <FieldText
            label="Priority"
            type="number"
            value={String(ruleForm.priority)}
            onChange={(priority) => setRuleForm({ ...ruleForm, priority: Number(priority) })}
          />
          <Button
            onClick={() =>
              saveAndRefresh(
                () => createCategoryRule({ ...ruleForm, businessId: ruleForm.businessId || null }),
                'Rule created.',
              )
            }
          >
            Create rule
          </Button>
        </CardContent>
      </Card>

      <Card className="lg:col-span-8">
        <CardHeader>
          <CardTitle>Rules</CardTitle>
          <CardDescription>
            {data.rules.length} active rule{data.rules.length === 1 ? '' : 's'}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2">
            {data.rules.length ? (
              data.rules.map((rule) => (
                <EditableRule
                  key={rule.id}
                  rule={rule}
                  categories={data.categories}
                  onSave={(body) => saveAndRefresh(() => updateCategoryRule(rule.id, body), 'Rule saved.')}
                />
              ))
            ) : (
              <EmptyState title="No rules yet" description="Rules auto-categorize transactions as they come in." />
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
