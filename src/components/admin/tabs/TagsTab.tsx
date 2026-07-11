import { useEffect, useState } from 'react';
import { ChevronDown, History, Tags as TagsIcon, Trash2 } from 'lucide-react';
import {
  applyTagToHistory,
  createTag,
  createTagRule,
  deleteTag,
  deleteTagRule,
  listTagRules,
  listTags,
  updateTag,
} from '@/api';
import type { Tag, TagRule, TagRuleMatchKind } from '@/types/domain';
import { useToast } from '@/hooks/useToast';
import { cn } from '@/lib/cn';
import { fmt$ } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { FieldColor, FieldText } from '../fields';

const MATCH_KINDS: Array<{ value: TagRuleMatchKind; label: string }> = [
  { value: 'merchant_contains', label: 'Merchant contains' },
  { value: 'merchant_exact', label: 'Merchant exact' },
  { value: 'category_exact', label: 'Category is' },
  { value: 'receipt_contains', label: 'Receipt contains' },
];

const MATCH_KIND_LABELS: Record<TagRuleMatchKind, string> = {
  merchant_exact: 'Merchant is',
  merchant_contains: 'Merchant contains',
  category_exact: 'Category is',
  receipt_contains: 'Receipt contains',
};

/**
 * Custom tags — a cross-business layer on top of categories (e.g. an "AI" tag that
 * collects OpenAI + Anthropic spend). Each tag carries auto-apply rules based on
 * merchant, category, or matched receipt evidence.
 */
export function TagsTab() {
  const { toast } = useToast();
  const [tags, setTags] = useState<Tag[]>([]);
  const [rulesByTag, setRulesByTag] = useState<Record<string, TagRule[]>>({});
  const [openTagId, setOpenTagId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyTagId, setBusyTagId] = useState<string | null>(null);
  const [tagForm, setTagForm] = useState({ name: '', color: '#7C5CFF' });
  const [ruleForm, setRuleForm] = useState<{ matchKind: TagRuleMatchKind; pattern: string }>({
    matchKind: 'merchant_contains',
    pattern: '',
  });
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    listTags()
      .then(setTags)
      .catch((error: Error) => toast({ variant: 'destructive', title: 'Failed to load tags', description: error.message }))
      .finally(() => setLoading(false));
  }, [refreshKey, toast]);

  const refresh = () => setRefreshKey((key) => key + 1);

  const loadRules = (tagId: string) => {
    listTagRules(tagId)
      .then((rules) => setRulesByTag((current) => ({ ...current, [tagId]: rules })))
      .catch((error: Error) => toast({ variant: 'destructive', title: 'Failed to load rules', description: error.message }));
  };

  const toggleOpen = (tagId: string) => {
    const next = openTagId === tagId ? null : tagId;
    setOpenTagId(next);
    setRuleForm({ matchKind: 'merchant_contains', pattern: '' });
    if (next && !rulesByTag[next]) loadRules(next);
  };

  const run = async (tagId: string | null, work: () => Promise<void>, failTitle: string) => {
    setBusyTagId(tagId);
    try {
      await work();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: failTitle,
        description: error instanceof Error ? error.message : 'Try again.',
      });
    } finally {
      setBusyTagId(null);
    }
  };

  const handleCreateTag = () => run(null, async () => {
    if (!tagForm.name.trim()) throw new Error('Give the tag a name.');
    await createTag({ name: tagForm.name.trim(), color: tagForm.color });
    toast({ variant: 'success', title: 'Tag created', description: 'Add merchant rules to auto-apply it.' });
    setTagForm({ name: '', color: '#7C5CFF' });
    refresh();
  }, 'Could not create tag');

  const handleToggleActive = (tag: Tag) => run(tag.id, async () => {
    await updateTag(tag.id, { active: !tag.active });
    refresh();
  }, 'Could not update tag');

  const handleDeleteTag = (tag: Tag) => run(tag.id, async () => {
    await deleteTag(tag.id);
    toast({ variant: 'success', title: 'Tag deleted', description: `"${tag.name}" was removed from every transaction.` });
    if (openTagId === tag.id) setOpenTagId(null);
    refresh();
  }, 'Could not delete tag');

  const handleAddRule = (tag: Tag) => run(tag.id, async () => {
    if (!ruleForm.pattern.trim()) throw new Error('Enter a rule value.');
    await createTagRule(tag.id, { matchKind: ruleForm.matchKind, pattern: ruleForm.pattern.trim() });
    toast({
      variant: 'success',
      title: 'Rule added',
      description: 'New transactions will pick it up automatically — use "Apply to history" for existing ones.',
    });
    setRuleForm({ matchKind: 'merchant_contains', pattern: '' });
    loadRules(tag.id);
  }, 'Could not add rule');

  const handleDeleteRule = (tag: Tag, rule: TagRule) => run(tag.id, async () => {
    await deleteTagRule(rule.id);
    toast({ variant: 'success', title: 'Rule deleted', description: `"${rule.pattern}" no longer auto-applies.` });
    loadRules(tag.id);
  }, 'Could not delete rule');

  const handleApply = (tag: Tag) => run(tag.id, async () => {
    const result = await applyTagToHistory(tag.id);
    toast({
      variant: 'success',
      title: `Tagged ${result.tagged} transaction${result.tagged === 1 ? '' : 's'}`,
      description: result.tagged === 0 ? 'Everything matching was already tagged.' : undefined,
    });
    refresh();
  }, 'Could not apply tag');

  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <Card className="self-start lg:col-span-4">
        <CardHeader>
          <CardTitle>Create tag</CardTitle>
          <CardDescription>
            A label that cuts across businesses and categories — e.g. "AI" for OpenAI and
            Anthropic spend. Add merchant, category, or receipt rules to apply it automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <FieldText label="Name" value={tagForm.name} onChange={(name) => setTagForm({ ...tagForm, name })} />
          <FieldColor label="Color" value={tagForm.color} onChange={(color) => setTagForm({ ...tagForm, color })} />
          <Button onClick={handleCreateTag} disabled={busyTagId !== null}>Create tag</Button>
        </CardContent>
      </Card>

      <Card className="lg:col-span-8">
        <CardHeader>
          <CardTitle>Tags</CardTitle>
          <CardDescription>
            {tags.length} tag{tags.length === 1 ? '' : 's'}. Expand one to manage its auto-apply rules.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2">
            {tags.map((tag) => {
              const open = openTagId === tag.id;
              const rules = rulesByTag[tag.id];
              const busy = busyTagId === tag.id;
              return (
                <Collapsible
                  key={tag.id}
                  open={open}
                  onOpenChange={() => toggleOpen(tag.id)}
                  className="rounded-lg border border-ink2/10 bg-[hsl(var(--color-sunken))]"
                >
                  <CollapsibleTrigger asChild>
                    <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: tag.color }} />
                      <span className="min-w-0 flex-1">
                        <span className={cn('block truncate text-sm font-bold text-ink', !tag.active && 'opacity-50')}>
                          {tag.name}
                          {!tag.active && <span className="ml-2 text-[10px] font-bold uppercase text-dim">paused</span>}
                        </span>
                        <span className="block truncate text-xs text-dim">
                          {tag.txnCount ?? 0} transaction{(tag.txnCount ?? 0) === 1 ? '' : 's'}
                          {tag.totalCents != null && tag.totalCents > 0 && ` · ${fmt$(tag.totalCents / 100)} spend`}
                        </span>
                      </span>
                      <ChevronDown className={cn('h-4 w-4 text-dim transition-transform', open && 'rotate-180')} />
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="grid gap-3 border-t border-ink2/10 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <label className="flex items-center gap-2 text-xs font-bold text-ink">
                          <Switch checked={tag.active} disabled={busy} onCheckedChange={() => handleToggleActive(tag)} />
                          Auto-apply active
                        </label>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy || !(rules?.length ?? tag.txnCount)}
                            onClick={() => handleApply(tag)}
                            title="Run this tag's rules across all existing transactions"
                          >
                            <History className="h-3.5 w-3.5" />
                            Apply to history
                          </Button>
                          <Button variant="ghost" size="sm" disabled={busy} onClick={() => handleDeleteTag(tag)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>

                      <div className="grid gap-1.5">
                        <div className="font-mono text-[10px] font-medium uppercase tracking-wider text-dim">
                          Auto-apply rules
                        </div>
                        {!rules && <div className="text-xs text-dim">Loading rules…</div>}
                        {rules?.length === 0 && (
                          <div className="text-xs text-dim">No rules yet — this tag is manual-only.</div>
                        )}
                        {rules?.map((rule) => (
                          <div
                            key={rule.id}
                            className="flex items-center gap-2 rounded-md border border-ink2/10 bg-paper px-2.5 py-1.5 text-xs"
                          >
                            <span className="text-[11px] uppercase tracking-wide text-dim">
                              {MATCH_KIND_LABELS[rule.matchKind]}
                            </span>
                            <span className="flex-1 truncate font-bold">“{rule.pattern}”</span>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleDeleteRule(tag, rule)}
                              className="text-dim hover:text-ink"
                              aria-label={`Delete rule ${rule.pattern}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Select
                          value={ruleForm.matchKind}
                          onValueChange={(value) => setRuleForm({ ...ruleForm, matchKind: value as TagRuleMatchKind })}
                        >
                          <SelectTrigger className="h-8 w-44 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {MATCH_KINDS.map((kind) => (
                              <SelectItem key={kind.value} value={kind.value}>{kind.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Input
                          value={ruleForm.pattern}
                          onChange={(event) => setRuleForm({ ...ruleForm, pattern: event.target.value })}
                          placeholder={ruleForm.matchKind === 'category_exact' ? 'e.g. Software' : 'e.g. openai'}
                          className="h-8 w-44 text-xs"
                        />
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => handleAddRule(tag)}>
                          Add rule
                        </Button>
                      </div>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              );
            })}
          </div>
          {loading && <div className="p-6 text-center text-sm text-dim">Loading tags…</div>}
          {!loading && tags.length === 0 && (
            <EmptyState
              title="No tags yet"
              description={'Create one on the left — e.g. an "AI" tag with rules for openai and anthropic.'}
              icon={<TagsIcon className="h-5 w-5" />}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
