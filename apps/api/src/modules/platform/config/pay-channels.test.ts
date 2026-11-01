// B2-15k: implementer's unit tests of the collection channel environment (the acceptance tests are
// test/spec/payment/channels/config.test.ts).
import { describe, expect, it } from 'vitest';
import { readPayChannelsConfig } from './pay-channels.ts';

describe('readPayChannelsConfig', () => {
  it('[AC-B2-15k-U#40] local / test: nothing read; PAY_CHANNEL_IMPL still accepts only fake', () => {
    expect(readPayChannelsConfig('test', { PAY_CHANNEL_IMPL: 'fake' }, 'api')).toEqual({
      payChannels: null,
      problems: [],
    });
    expect(readPayChannelsConfig('local', { PAY_CHANNEL_IMPL: 'x' }, 'api').problems).toHaveLength(
      1,
    );
  });

  it('[AC-B2-15k-U#41] an empty value counts as unset; the test merchant flag is exactly 1', () => {
    const { payChannels, problems } = readPayChannelsConfig(
      'staging',
      { PAY_APP_ID: '', PAY_WECHAT_TEST_MERCHANT: 'true' },
      'worker',
    );
    expect(problems).toEqual([]);
    expect(payChannels?.appId).toBeNull();
    expect(payChannels?.wechat.testMerchant).toBe(false);
    const flagged = readPayChannelsConfig('staging', { PAY_WECHAT_TEST_MERCHANT: '1' }, 'admin');
    expect(flagged.payChannels?.wechat.testMerchant).toBe(true);
  });

  it('[AC-B2-15k-U#42] problems name the variable and never echo a value', () => {
    const value = 'http://secret-host.example.test';
    const { problems } = readPayChannelsConfig('staging', { PAY_NOTIFY_BASE_URL: value }, 'api');
    expect(problems.join('\n')).toContain('PAY_NOTIFY_BASE_URL');
    expect(problems.join('\n')).not.toContain('secret-host');
  });
});
