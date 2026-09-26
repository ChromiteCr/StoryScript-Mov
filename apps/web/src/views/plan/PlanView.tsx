import { lazy, Suspense } from 'react';
import { Spinner } from '../../components/ui.tsx';

/**
 * #/plan entry. The page (and the core scheduling/export helpers it pulls
 * in) is its own chunk, loaded the first time the plan stage opens.
 */
const PlanRoute = lazy(() => import('./PlanPage.tsx'));

export function PlanView() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Spinner label="正在打开计划页…" />
        </div>
      }
    >
      <PlanRoute />
    </Suspense>
  );
}
