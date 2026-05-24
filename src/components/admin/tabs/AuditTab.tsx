import type { AuditLogRow } from '@/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface Props {
  rows: AuditLogRow[];
  query: string;
}

export function AuditTab({ rows, query }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit log</CardTitle>
        <CardDescription>
          {rows.length} event{rows.length === 1 ? '' : 's'}
          {query && ` matching "${query}"`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length ? (
          <div className="overflow-hidden rounded-md border border-ink2/10">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Action</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead className="text-right">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.slice(0, 200).map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-bold">{row.action}</TableCell>
                    <TableCell className="text-dim">{row.entityType}</TableCell>
                    <TableCell className="text-right text-xs text-dim">
                      {new Date(row.createdAt).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="No audit events" description="Actions you take here will be logged." />
        )}
      </CardContent>
    </Card>
  );
}
