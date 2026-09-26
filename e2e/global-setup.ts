import { buildWeb } from './support.ts';

/** Build the web app once for the whole run (the specs start the production server). */
export default function globalSetup(): void {
  if (process.env.E2E_NO_BUILD === '1') return;
  buildWeb();
}
