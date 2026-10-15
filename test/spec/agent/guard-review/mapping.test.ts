import { expect, it } from 'vitest';
import { defaultAliyunReviewDifferences } from '../../../../apps/api/src/modules/agent/guard/review/index.ts';
import { CONTENT, SIDES, fixture, response, verdictBody } from './kit.ts';

// 来源：https://help.aliyun.com/zh/document_detail/2671445.html（文档结论，未实测）。
// Code=200 才成功；none 无风险。其余已知风险等级按 BR-AI-18「命中」拒绝。
it('[AC-B3-06b#1][BR-AI-18] 默认差异表只声明文档字段、值与两种审核场景', () => {
  expect(defaultAliyunReviewDifferences()).toEqual({
    inputService: 'llm_query_moderation',
    outputService: 'llm_response_moderation',
    codePath: ['Code'],
    successCode: 200,
    verdictPath: ['Data', 'RiskLevel'],
    passValues: ['none'],
    blockValues: ['high', 'medium', 'low'],
  });
});

for (const side of SIDES) {
  it.each([
    ['none', 'pass'],
    ['high', 'block'],
    ['medium', 'block'],
    ['low', 'block'],
  ] as const)(`[AC-B3-06b#2][BR-AI-18] ${side} 默认判定 %s → %s`, async (risk, verdict) => {
    const f = fixture(side, { fetch: () => Promise.resolve(response(verdictBody(risk))) });
    await expect(f.port.review(CONTENT)).resolves.toBe(verdict);
    expect(f.calls).toHaveLength(1);
  });

  it.each([
    ['缺少 Code', { Data: { RiskLevel: 'none' } }],
    ['业务错误码', { Code: 500, Data: { RiskLevel: 'none' } }],
    ['业务超时码', { Code: 581, Data: { RiskLevel: 'none' } }],
    ['字符串 Code', { Code: '200', Data: { RiskLevel: 'none' } }],
    ['无 Data', { Code: 200 }],
    ['空 Data', { Code: 200, Data: null }],
    ['错误字段大小写', { Code: 200, data: { riskLevel: 'none' } }],
    ['旧协议字段', { Code: 200, Data: { suggestion: 'pass' } }],
    ['嵌套位置错误', { Code: 200, RiskLevel: 'none' }],
    ['无风险等级', { Code: 200, Data: {} }],
    ['未知风险值', verdictBody('new-risk')],
    ['风险值大小写错误', verdictBody('NONE')],
    ['风险值多余空白', verdictBody(' none ')],
    ['风险值为数字', { Code: 200, Data: { RiskLevel: 0 } }],
    ['风险值为数组', { Code: 200, Data: { RiskLevel: ['none'] } }],
    ['风险值为空', { Code: 200, Data: { RiskLevel: null } }],
    ['空对象', {}],
    ['顶层为空', null],
    ['顶层为字符串', 'none'],
    ['顶层为数组', [verdictBody('none')]],
    ['代答文本不是放行证据', { Code: 200, Data: { Advice: [{ Answer: '合成代答' }] } }],
  ])(`[AC-B3-06b#3][BR-AI-18] ${side} %s 一律 timeout`, async (_label, body) => {
    const f = fixture(side, { fetch: () => Promise.resolve(response(body)) });
    await expect(f.port.review(CONTENT)).resolves.toBe('timeout');
  });

  it.each([199, 301, 302, 307, 308, 400, 401, 429, 500, 503])(
    `[AC-B3-06b#4][BR-AI-18] ${side} HTTP %s 即使正文是 pass 也 fail-close`,
    async (status) => {
      const f = fixture(side, {
        fetch: () => Promise.resolve(response(verdictBody('none'), status)),
      });
      await expect(f.port.review(CONTENT)).resolves.toBe('timeout');
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]?.init.redirect).toBe('error');
    },
  );

  it.each(['', '{', '<html>synthetic error</html>'])(
    `[AC-B3-06b#5][BR-AI-18] ${side} 非 JSON 正文 %j → timeout`,
    async (body) => {
      const f = fixture(side, {
        fetch: () => Promise.resolve({ status: 200, text: () => Promise.resolve(body) }),
      });
      await expect(f.port.review(CONTENT)).resolves.toBe('timeout');
    },
  );

  it.each([
    ['synthetic-clear', 'pass'],
    ['synthetic-hit', 'block'],
    ['none', 'timeout'],
    ['synthetic-unknown', 'timeout'],
  ] as const)(
    `[AC-B3-06b#6][BR-AI-18] ${side} 注入差异表以声明的字段和值判定 %s`,
    async (value, verdict) => {
      // 仅验证差异表机制，不宣称这是阿里云的另一套协议。
      const f = fixture(side, {
        differences: {
          inputService: 'synthetic-input-service',
          outputService: 'synthetic-output-service',
          codePath: ['Synthetic', 'Code'],
          successCode: 200,
          verdictPath: ['Synthetic', 'Decision'],
          passValues: ['synthetic-clear'],
          blockValues: ['synthetic-hit'],
        },
        fetch: () =>
          Promise.resolve(
            response({
              Synthetic: { Code: 200, Decision: value },
              Code: 200,
              Data: { RiskLevel: 'none' }, // 陷阱：不能绕过已注入的差异表。
            }),
          ),
      });
      await expect(f.port.review(CONTENT)).resolves.toBe(verdict);
      expect(new URLSearchParams(f.calls[0]?.init.body).get('Service')).toBe(
        side === 'input' ? 'synthetic-input-service' : 'synthetic-output-service',
      );
    },
  );
}
