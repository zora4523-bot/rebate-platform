// B2-11e (structure only, behaviour unchanged): the checks B2-11d added to the console's config item
// and switch use cases are injected through ContentAdminModule.forAdmin's options instead of
// app.module rebuilding content's providers. configItemChecks is ConfigItemAdmin's checks as is
// (payout's 保存时校验, BR-WDR-30); killSwitchChecks builds KillSwitchAdmin's checks (payout's 开启前置
// 检查) from the entry's database handle and clock, and only when there is one — without a database
// turning withdraw.auto_payout.enabled on stays refused, as today. The stand-in checks here record
// their calls; the rule values themselves are B2-11d's (test/spec/payout/auto-config).
import { expect, it, vi } from 'vitest';
import type { ContentKillSwitchChecksFactory } from '../../../../apps/api/src/modules/content/index.ts';
import { ACTOR, failure, harness } from './kit.ts';

/** A key the stand-in save check reads, and an editable one it does not. */
const CHECKED = 'withdraw.auto_payout.max_amount_fen';
const UNCHECKED = 'withdraw.auto_payout.payee_daily_max_count';
const AUTO = 'withdraw.auto_payout.enabled';

type Refusals = (
  stored: ReadonlyMap<string, unknown>,
  written: ReadonlyMap<string, unknown>,
) => readonly string[];

/** A save check over CHECKED that refuses it whatever the values. */
function refusingSave() {
  const refusals = vi.fn<Refusals>(() => [CHECKED]);
  return { refusals, configItemChecks: { save: { keys: [CHECKED], refusals } } };
}

/** The error name of a settled rejection (undefined when the call resolved). */
function nameOf(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function precheckAnswering(passed: boolean) {
  return vi.fn<(appId: string) => Promise<{ readonly passed: boolean }>>(async () => ({ passed }));
}

it('[AC-B2-11e#1] forAdmin 的 configItemChecks 接到单条保存：写校验读的键时问一次 save 校验（本 app 存量、写入值），拒绝 → 20001 [value]；不读的键不问', async () => {
  const { refusals, configItemChecks } = refusingSave();
  const h = await harness({ configItemChecks });
  try {
    const error = await failure(
      h.configItems.update(ACTOR, CHECKED, { value: 500001, expected_version: 0 }),
    );
    expect(error).toMatchObject({ name: 'ConfigItemFieldsError', fields: ['value'] });
    expect(refusals).toHaveBeenCalledTimes(1);
    expect(refusals).toHaveBeenCalledWith(new Map(), new Map([[CHECKED, 500001]]));
    await failure(h.configItems.update(ACTOR, UNCHECKED, { value: 3, expected_version: 0 }));
    expect(refusals).toHaveBeenCalledTimes(1);
  } finally {
    await h.close();
  }
});

it('[AC-B2-11e#2] forAdmin 的 configItemChecks 接到批量保存：整批按写入值问一次，拒绝 → 20001，fields 为被拒的键', async () => {
  const { refusals, configItemChecks } = refusingSave();
  const h = await harness({ configItemChecks });
  try {
    const error = await failure(
      h.configItems.batch(ACTOR, {
        items: [
          { key: CHECKED, value: 500001, expected_version: 0 },
          { key: UNCHECKED, value: 3, expected_version: 0 },
        ],
      }),
    );
    expect(error).toMatchObject({ name: 'ConfigItemFieldsError', fields: [CHECKED] });
    expect(refusals).toHaveBeenCalledTimes(1);
    expect(refusals).toHaveBeenCalledWith(
      new Map(),
      new Map<string, unknown>([
        [CHECKED, 500001],
        [UNCHECKED, 3],
      ]),
    );
  } finally {
    await h.close();
  }
});

it('[AC-B2-11e#3] forAdmin 的 killSwitchChecks：有库时以入口的库与时钟建检查；打开自动到账总开关问本 app 一次，不通过 → 20001 [value]', async () => {
  const precheck = precheckAnswering(false);
  const build = vi.fn<ContentKillSwitchChecksFactory>(() => ({ autoPayoutEnable: precheck }));
  const h = await harness({ killSwitchChecks: build });
  try {
    expect(build).toHaveBeenCalledWith(h.db, h.clock);
    const error = await failure(
      h.switches.update(ACTOR, AUTO, { value: true, expected_version: 0 }),
    );
    expect(error).toMatchObject({ name: 'KillSwitchFieldsError', fields: ['value'] });
    expect(precheck).toHaveBeenCalledTimes(1);
    expect(precheck).toHaveBeenCalledWith(ACTOR.appId);
  } finally {
    await h.close();
  }
});

it('[AC-B2-11e#4] killSwitchChecks 的前置检查通过时不再因 value 拒绝打开；无库时不建检查、打开仍拒绝 [value]（与现在一致）', async () => {
  const precheck = precheckAnswering(true);
  const build = vi.fn<ContentKillSwitchChecksFactory>(() => ({ autoPayoutEnable: precheck }));
  const h = await harness({ killSwitchChecks: build });
  try {
    const error = await failure(
      h.switches.update(ACTOR, AUTO, { value: true, expected_version: 0 }),
    );
    expect(precheck).toHaveBeenCalledWith(ACTOR.appId);
    expect(nameOf(error)).not.toBe('KillSwitchFieldsError');
  } finally {
    await h.close();
  }
  const offline = vi.fn<ContentKillSwitchChecksFactory>(() => ({ autoPayoutEnable: precheck }));
  const bare = await harness({ killSwitchChecks: offline }, 'absent');
  try {
    precheck.mockClear();
    const error = await failure(
      bare.switches.update(ACTOR, AUTO, { value: true, expected_version: 0 }),
    );
    expect(error).toMatchObject({ name: 'KillSwitchFieldsError', fields: ['value'] });
    expect(offline).not.toHaveBeenCalled();
    expect(precheck).not.toHaveBeenCalled();
  } finally {
    await bare.close();
  }
});

it('[AC-B2-11e#5] 只有传了选项才校验：同一写入有 configItemChecks 时停在校验，没有时照常进库；不传 killSwitchChecks 打开自动到账总开关仍拒绝 [value]', async () => {
  const { configItemChecks } = refusingSave();
  const checked = await harness({ configItemChecks });
  const plain = await harness({});
  try {
    const refused = await failure(
      checked.configItems.update(ACTOR, CHECKED, { value: 500001, expected_version: 0 }),
    );
    const stored = await failure(
      plain.configItems.update(ACTOR, CHECKED, { value: 500001, expected_version: 0 }),
    );
    expect(refused).toMatchObject({ name: 'ConfigItemFieldsError' });
    expect(nameOf(stored)).not.toBe('ConfigItemFieldsError');
    const error = await failure(
      plain.switches.update(ACTOR, AUTO, { value: true, expected_version: 0 }),
    );
    expect(error).toMatchObject({ name: 'KillSwitchFieldsError', fields: ['value'] });
    // The registry app.module now takes from content's index.ts.
    const keys = plain.content.configRegistry().map((spec) => spec.key);
    expect(keys).toContain(CHECKED);
    expect(keys).toContain(UNCHECKED);
  } finally {
    await checked.close();
    await plain.close();
  }
});
