import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ScriptImportResult } from '@storyscript/contracts';
import { api, createProject, signIn, startApp, type RunningApp } from './support.ts';

/**
 * S3b (no key, nothing leaves the machine): the script starts with a cast
 * list ("人物：" and the lines after it) → the two characters are added by
 * hand → the 角色 panel says the list names 2 actors → 填入演员… → both
 * ticked, applied, the list shows who plays whom → 计划 → 同步… → the new
 * performers are created, confirmed with their availability → the resources
 * panel lists them as performers with the characters they play.
 * All names are made up.
 */

const SCRIPT = ['人物：', '周远：裴明远：主角', '孙晴：林川：小孩子', '剧本：', '1. 内景 教室 日', '裴明远走进教室，林川抬起头。'].join('\n');

let app: RunningApp;

test.beforeAll(async () => {
  app = await startApp({ noKey: true });
});
test.afterAll(async () => {
  await app?.stop();
});

test('S3b cast: cast list → 填入演员 → plan 同步 → performers with their characters', async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await signIn(page, app);
  await createProject(page, join(app.projectsDir, 'e2e-cast'), '演员表测试');

  await test.step('import the script; add the two characters by hand', async () => {
    await api<ScriptImportResult>(page, 'POST', '/api/v1/scripts', { text: SCRIPT, source_name: 'cast.txt', format: 'txt', heading_overrides: [] });
    await page.goto(`${app.base}/#/script`);
    await page.reload();
    await page.getByRole('region', { name: '内景 教室 日', exact: true }).waitFor();

    const roster = page.getByRole('region', { name: /^角色 · 地点 · 道具/ });
    await roster.getByRole('button', { name: '新增角色、地点或道具' }).click();
    const name = roster.getByRole('textbox', { name: '名称', exact: true });
    for (const who of ['裴明远', '林川']) {
      await name.fill(who);
      await roster.getByRole('button', { name: '新增', exact: true }).click();
      await expect(roster.getByRole('list').getByText(who, { exact: true })).toBeVisible();
    }
    await roster.getByRole('button', { name: '完成', exact: true }).click();
    // no actor typed by hand: the cast list is where they come from
    await expect(roster.getByText('饰')).toHaveCount(0);
  });

  const roster = page.getByRole('region', { name: /^角色 · 地点 · 道具/ });

  await test.step('the 人物表 notice → 填入演员…: both lines ticked, applied', async () => {
    await expect(roster.getByText('剧本的人物表写了 2 位演员')).toBeVisible();
    await roster.getByRole('button', { name: '填入演员…' }).click();

    const dialog = page.getByRole('dialog', { name: '填入演员' });
    await expect(dialog.getByText('拆镜和润色不会把它发给 AI', { exact: false })).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: '填入：周远：裴明远：主角' })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: '填入：孙晴：林川：小孩子' })).toBeChecked();
    await expect(dialog.getByRole('textbox', { name: /^演员（周远：裴明远/ })).toHaveValue('周远');
    await page.screenshot({ path: test.info().outputPath('cast-dialog.png') });

    await dialog.getByRole('button', { name: /^填入所选（2）/ }).click();
    await dialog.waitFor({ state: 'detached' });

    await expect(roster.getByText('周远 饰')).toBeVisible();
    await expect(roster.getByText('孙晴 饰')).toBeVisible();
    // everything is filled in: the notice is gone
    await expect(roster.getByText('剧本的人物表写了')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('cast-filled.png') });
  });

  await test.step('计划: 同步… creates the two performers', async () => {
    await page.goto(`${app.base}/#/plan`);
    const resources = page.getByRole('region', { name: '资源', exact: true });
    await expect(resources.getByText('剧本里的演员表和地点有 2 处还没同步到计划')).toBeVisible();
    await resources.getByRole('button', { name: '同步…' }).click();

    const dialog = page.getByRole('dialog', { name: '同步演员和场地' });
    const newPeople = dialog.getByRole('region', { name: '新演员', exact: true });
    await expect(newPeople.getByText('周远：饰 裴明远')).toBeVisible();
    await expect(newPeople.getByText('孙晴：饰 林川')).toBeVisible();
    // no location entities in this script: nothing to sync there
    await expect(dialog.getByRole('region', { name: '场地', exact: true })).toHaveCount(0);

    const confirmed = dialog.getByRole('checkbox', { name: /这些人和地点这段时间都能到场/ });
    await expect(confirmed).not.toBeChecked();
    await expect(dialog.getByText('不勾的话，新建的演员和场地标为待确认，批准计划前要逐个确认。')).toBeVisible();
    await confirmed.check();
    await page.screenshot({ path: test.info().outputPath('cast-sync-dialog.png') });

    await dialog.getByRole('button', { name: '同步到计划' }).click();
    await dialog.waitFor({ state: 'detached' });

    const performers = resources.getByRole('region', { name: '演员', exact: true });
    await expect(performers.getByText('周远', { exact: true })).toBeVisible();
    await expect(performers.getByText('孙晴', { exact: true })).toBeVisible();
    await expect(performers.getByText('饰 裴明远')).toBeVisible();
    await expect(performers.getByText('饰 林川')).toBeVisible();
    await expect(performers.getByText('未确认')).toHaveCount(0);
    // the script and the plan agree now
    await expect(resources.getByRole('button', { name: '同步…' })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('cast-synced.png') });
  });

  expect(pageErrors).toEqual([]);
});
