import { randomUUID } from 'node:crypto';
import {
  StyleResearchOutput,
  type StyleCard,
  type StyleCardInput,
  type StyleDefaults,
  type StyleLibrary,
} from '@storyscript/contracts';
import { BUILTIN_STYLES, findBuiltinStyle, type BreakdownStyle } from '@storyscript/core';
import type { DbPort } from '../db/port.ts';
import { getDraft, setDraftStatus } from '../db/repos/draft.ts';
import { deleteStyleRow, getStyle, insertStyle, listStyles, readStyleDefaults, updateStyleRow, writeStyleDefaults } from '../db/repos/style.ts';
import { AppError } from '../http/errors.ts';

/**
 * S3 style library: the built-in cards (core, read-only) plus the group's own
 * cards, and the group's defaults for new breakdown and polish requests.
 * Researched cards come from a style draft the user reviewed and saved.
 */

export function styleLibrary(db: DbPort): StyleLibrary {
  return { cards: [...BUILTIN_STYLES, ...listStyles(db)], defaults: readStyleDefaults(db) };
}

/** A built-in or group card by id; unknown ids are a 400 (the request named it). */
export function resolveStyle(db: DbPort, id: string | null): StyleCard | null {
  if (id === null) return null;
  const card = findBuiltinStyle(id) ?? getStyle(db, id);
  if (!card) throw new AppError('VALIDATION_ERROR', '这个风格卡不存在，可能已被组员删除。请重新选择风格。', 400, { style_id: id });
  return card;
}

/** The parts of a card the prompts see: never the user's reference text. */
export function promptStyle(card: StyleCard | null): BreakdownStyle | null {
  if (!card) return null;
  return { name: card.name, grammar: card.grammar, bias: card.bias, gear: card.gear, low_budget: card.low_budget, unverified: card.unverified };
}

export function createStyle(
  db: DbPort,
  input: StyleCardInput,
  origin: 'custom' | 'researched' = 'custom',
  reference: string | null = null,
  now = new Date().toISOString(),
): StyleCard {
  const card: StyleCard = {
    id: randomUUID(),
    ...input,
    origin,
    reference: origin === 'researched' ? reference : null,
    unverified: origin === 'researched',
    created_at: now,
    updated_at: now,
  };
  insertStyle(db, card);
  return card;
}

function requireOwnStyle(db: DbPort, id: string): StyleCard {
  if (findBuiltinStyle(id)) throw new AppError('FORBIDDEN', '内置风格卡不能修改。可以复制一份再改。', 403);
  const card = getStyle(db, id);
  if (!card) throw new AppError('NOT_FOUND', '风格卡不存在', 404);
  return card;
}

export function updateStyle(db: DbPort, id: string, input: StyleCardInput, now = new Date().toISOString()): StyleCard {
  return db.tx(() => {
    const card = requireOwnStyle(db, id);
    const next: StyleCard = { ...card, ...input, updated_at: now };
    updateStyleRow(db, next);
    return next;
  });
}

export function deleteStyle(db: DbPort, id: string, now = new Date().toISOString()): { id: string } {
  return db.tx(() => {
    requireOwnStyle(db, id);
    deleteStyleRow(db, id);
    const d = readStyleDefaults(db);
    if (d.style_id === id) writeStyleDefaults(db, { ...d, style_id: null }, now);
    return { id };
  });
}

export function saveStyleDefaults(db: DbPort, input: StyleDefaults, now = new Date().toISOString()): StyleLibrary {
  return db.tx(() => {
    resolveStyle(db, input.style_id);
    writeStyleDefaults(db, input, now);
    return styleLibrary(db);
  });
}

export interface StyleDraftScope {
  reference: string;
  notes: string | null;
}

/** Save a reviewed research draft as the group's card (researched, unverified). */
export function saveResearchedStyle(db: DbPort, draftId: string, input: StyleCardInput, now = new Date().toISOString()): StyleCard {
  return db.tx(() => {
    const draft = getDraft(db, draftId);
    if (!draft || draft.kind !== 'style') throw new AppError('NOT_FOUND', '风格研究草案不存在', 404);
    if (draft.status !== 'pending') throw new AppError('VALIDATION_ERROR', `草案状态为 ${draft.status}，不能保存`, 409);
    if (!StyleResearchOutput.safeParse(draft.parsed).success) throw new AppError('VALIDATION_ERROR', '草案没有可保存的内容', 409);
    const scope = draft.scope as Partial<StyleDraftScope>;
    const reference = typeof scope.reference === 'string' ? scope.reference.slice(0, 200) : null;
    const card = createStyle(db, input, 'researched', reference, now);
    setDraftStatus(db, draft.id, 'applied');
    return card;
  });
}
