import { expect, it } from 'vitest';
import { signResponse } from './labor-agreement.controller.ts';

const TRACE = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b';

it('[AC-B1-13l] sign: a version mismatch answers 403 / 10004 with consent_type only', () => {
  expect(signResponse({ code: 10004, data: { consent_type: 'labor_agreement' } }, TRACE)).toEqual({
    status: 403,
    envelope: {
      code: 10004,
      msg: expect.any(String),
      data: { consent_type: 'labor_agreement' },
      trace_id: TRACE,
    },
  });
});

it('[AC-B1-13l] sign: field mismatches answer 400 / 20001 with the listed fields', () => {
  expect(signResponse({ code: 20001, data: { fields: ['text_sha256', 'agreed'] } }, TRACE)).toEqual(
    {
      status: 400,
      envelope: {
        code: 20001,
        msg: expect.any(String),
        data: { fields: ['text_sha256', 'agreed'] },
        trace_id: TRACE,
      },
    },
  );
});

it('[AC-B1-13l] sign: success and data-less refusals keep their shapes', () => {
  expect(signResponse({ code: 0 }, TRACE)).toEqual({
    status: 200,
    envelope: { code: 0, msg: '', data: {}, trace_id: TRACE },
  });
  const refused = signResponse({ code: 30304 }, TRACE);
  expect(refused.status).toBe(422);
  expect(refused.envelope).toEqual({ code: 30304, msg: expect.any(String), trace_id: TRACE });
  expect(signResponse({ code: 50001 }, TRACE).status).toBe(500);
});
