import type { Connection } from '@/types/domain';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Separator } from '@/components/ui/separator';
import { ListRow } from '../fields';

interface Props {
  connections: Connection[];
  onOpenConnections: () => void;
}

export function ConnectionsTab({ connections, onOpenConnections }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connection management</CardTitle>
        <CardDescription>Plaid and Gmail providers feeding this workspace.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Button variant="outline" className="self-start" onClick={onOpenConnections}>
          Open connection manager
        </Button>
        <Separator />
        <div className="grid gap-2">
          {connections.length ? (
            connections.map((connection) => (
              <ListRow
                key={connection.id ?? connection.label}
                left={
                  <div>
                    <div>{connection.label}</div>
                    {connection.health && (
                      <div className="mt-1 text-[11px] font-normal text-dim">
                        Sync {formatAdminTime(connection.health.lastSyncAt)} · {connection.kind === 'gmail' ? 'Pub/Sub' : 'Webhook'}{' '}
                        {formatAdminTime(connection.kind === 'gmail' ? connection.health.lastPubSubAt : connection.health.lastWebhookAt)}
                        {connection.health.failedJobCount > 0 && (
                          <span className="text-coral-ink"> · {connection.health.failedJobCount} failed</span>
                        )}
                      </div>
                    )}
                  </div>
                }
                right={
                  <Badge variant={connection.status === 'live' ? 'success' : connection.status === 'reauth' ? 'warning' : 'muted'}>
                    {connection.kind} · {connection.status}
                  </Badge>
                }
              />
            ))
          ) : (
            <EmptyState title="No connections yet" description="Open the connection manager to link Plaid or Gmail." />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function formatAdminTime(value?: string | null): string {
  if (!value) return 'never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
