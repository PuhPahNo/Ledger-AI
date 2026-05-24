import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { ConnectionStatus } from '@/types/domain';
import { Badge } from '@/components/ui/badge';

export function StatusBadge({ status }: { status: ConnectionStatus }) {
  if (status === 'live') {
    return (
      <Badge variant="success">
        <CheckCircle2 className="h-3 w-3" />
        Live
      </Badge>
    );
  }
  if (status === 'reauth') {
    return (
      <Badge variant="warning">
        <AlertTriangle className="h-3 w-3" />
        Needs reauth
      </Badge>
    );
  }
  return <Badge variant="muted">Disconnected</Badge>;
}
