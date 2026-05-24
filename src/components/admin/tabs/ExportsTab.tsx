import { createExport, type AdminOverview } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ListRow, type SaveAndRefresh } from '../fields';

interface Props {
  data: AdminOverview;
  saveAndRefresh: SaveAndRefresh;
}

export function ExportsTab({ data, saveAndRefresh }: Props) {
  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <Card className="lg:col-span-4">
        <CardHeader>
          <CardTitle>Audit export</CardTitle>
          <CardDescription>Queue a month-to-date CSV bundle.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            onClick={() =>
              saveAndRefresh(() => {
                const now = new Date();
                const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
                const to = now.toISOString().slice(0, 10);
                return createExport(from, to);
              }, 'Export queued.')
            }
          >
            Queue month-to-date export
          </Button>
        </CardContent>
      </Card>
      <Card className="lg:col-span-8">
        <CardHeader>
          <CardTitle>Recent exports</CardTitle>
        </CardHeader>
        <CardContent>
          {data.exports.length ? (
            <div className="grid gap-2">
              {data.exports.map((job) => (
                <ListRow
                  key={job.id}
                  left={`${job.dateFrom} → ${job.dateTo}`}
                  right={<Badge variant="muted">{job.status}</Badge>}
                />
              ))}
            </div>
          ) : (
            <EmptyState title="No exports yet" description="Queued exports will appear here." />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
