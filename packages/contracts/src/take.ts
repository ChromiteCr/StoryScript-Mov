import { z } from 'zod';
import { ActorRef, IsoTime, Uuid } from './common.ts';

export const TakeRating = z.enum(['good', 'alternate', 'reject', 'unrated']);
export type TakeRating = z.infer<typeof TakeRating>;

export const Take = z.object({
  id: Uuid,
  setup_id: Uuid.nullable(),
  take_no: z.number().int().positive(),
  camera_label: z.string().nullable(),
  rating: TakeRating,
  /** in-camera clip name recorded on set, e.g. A001C003 or IMG_1234 */
  clip_hint: z.string().nullable(),
  notes: z.string(),
  unresolved_labels: z.array(z.string()),
  logged_at: IsoTime,
  /** TakeShotLink — independent of any media (SPEC FR-07) */
  shot_ids: z.array(Uuid),
  revision: z.number().int().nonnegative(),
  /** S4: who logged the take */
  logged_by: ActorRef.nullable().optional(),
});
export type Take = z.infer<typeof Take>;
