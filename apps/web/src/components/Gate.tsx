import type { ReactNode } from 'react';
import { useSession } from '../state/session';
import { Empty } from '../brand/Boot';

/** Shows a page only to roles that hold the permission it needs; anyone else sees why, instead of a failed request. */
export function Gate({ need, children }: { need: string; children: ReactNode }) {
  const can = useSession((s) => s.can);
  if (can(need)) return <>{children}</>;
  return <Empty art="site" title="Not available for your role" description="This area needs a permission your role does not have. Ask an administrator if you need access." />;
}
