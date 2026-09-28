import { describe, expect, it, vi } from 'vitest';
import { createApiClient, type FetchLike } from '../src/lib/api.ts';
import { describeError } from '../src/lib/errors.ts';
import { pendingJoin, readJoinFromHash, setPendingJoin, takeJoinFromLocation } from '../src/lib/join.ts';
import { bootstrapSession, isNoTeam, markNoTeam, resetNoTeam } from '../src/lib/session.ts';
import { ApiClientError } from '../src/lib/api.ts';

// S2a (web side): group join links, the "no group yet" boot state, account error copy.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('group join links', () => {
  it('reads #join=<code> (also next to other parts), upper-cased; ignores junk', () => {
    expect(readJoinFromHash('#join=abcd-2345')).toBe('ABCD-2345');
    expect(readJoinFromHash('#a=1&join=ABCD-2345')).toBe('ABCD-2345');
    expect(readJoinFromHash('#/media')).toBeNull();
    expect(readJoinFromHash('#join=<script>')).toBeNull();
    expect(readJoinFromHash('')).toBeNull();
  });

  it('moves the code out of the address bar into pending storage', () => {
    setPendingJoin(null);
    const location = { hash: '#join=ABCD-2345', pathname: '/', search: '' };
    const replaceState = vi.fn();
    expect(takeJoinFromLocation(location, { state: null, replaceState })).toBe(true);
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
    expect(pendingJoin()).toBe('ABCD-2345');
    expect(takeJoinFromLocation({ hash: '#/script', pathname: '/', search: '' }, { state: null, replaceState })).toBe(false);
    setPendingJoin(null);
    expect(pendingJoin()).toBeNull();
  });
});

describe('boot on a hosted server', () => {
  it('signed in without a group: NO_TEAM from health means the group screen', async () => {
    const fetch: FetchLike = async () => json(409, { error: { code: 'NO_TEAM', message: '你还没有加入小组', retryable: false } });
    const r = await bootstrapSession({
      client: createApiClient(fetch),
      location: { hash: '', pathname: '/', search: '' },
      history: { state: null, replaceState: vi.fn() },
    });
    expect(r).toEqual({ kind: 'no-team' });
  });

  it('a later NO_TEAM (removed from the group) flips a flag the app listens to', () => {
    resetNoTeam();
    markNoTeam();
    expect(isNoTeam()).toBe(true);
    resetNoTeam();
    expect(isNoTeam()).toBe(false);
  });
});

describe('account error copy', () => {
  it('shows the server message itself for account forms', () => {
    const e = new ApiClientError({ code: 'FORBIDDEN', message: '邀请码不对，请向活动负责人确认。', status: 403, retryable: false });
    expect(describeError(e, 'account').title).toBe('邀请码不对，请向活动负责人确认。');
    const offline = new ApiClientError({ code: 'NETWORK_ERROR', message: 'Failed to fetch', status: 0, retryable: true });
    expect(describeError(offline, 'account').title).not.toBe('Failed to fetch');
  });
});
