import { expect, it } from 'vitest';
import { popupLottieFields } from './popup-lottie.ts';

const SHA = 'c'.repeat(64);
const expected = (sha256: string) => `https://media.test/m/${sha256}.json`;
const popup = (props: unknown) => ({ id: 'p', type: 'popup', props });

it('[AC-F1-09r] only popups with a mismatching lottie reference are named, by index', () => {
  const sections = [
    { id: 'b', type: 'banner', props: { lottie: { url: 'https://x.test/a.json', sha256: SHA } } },
    popup({ image: 'https://x.test/a.png' }),
    popup({ lottie: { url: expected(SHA), sha256: SHA } }),
    popup({ lottie: { url: `https://media.test/m/${'d'.repeat(64)}.json`, sha256: SHA } }),
    popup({ lottie: { url: `${expected(SHA)}#x`, sha256: SHA } }),
  ];
  expect(popupLottieFields(sections, expected)).toEqual([
    'sections.3.props.lottie',
    'sections.4.props.lottie',
  ]);
});

it('[AC-F1-09r] malformed references are left to the shape check; no media base rejects', () => {
  const malformed = [
    popup({ lottie: 'x' }),
    popup({ lottie: { url: 1, sha256: SHA } }),
    popup({ lottie: { url: expected(SHA), sha256: SHA.toUpperCase() } }),
    popup(null),
  ];
  expect(popupLottieFields(malformed, expected)).toEqual([]);
  expect(popupLottieFields('not an array', expected)).toEqual([]);
  expect(
    popupLottieFields([popup({ lottie: { url: expected(SHA), sha256: SHA } })], () => undefined),
  ).toEqual(['sections.0.props.lottie']);
});
