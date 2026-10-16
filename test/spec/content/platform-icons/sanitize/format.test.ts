import { gzipSync } from 'node:zlib';
import { it, expect, vi } from 'vitest';
import { inspectPlatformIcon } from '../../../../../apps/api/src/modules/content/domain/platform-icon/index.ts';
import { bytes, clean, inspect, options, success, svg, xml } from './kit.ts';

it.each([
  ['empty', new Uint8Array()],
  ['JPEG', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])],
  ['GIF', bytes('GIF89a')],
  ['WebP', bytes('RIFF0000WEBP')],
  ['text pretending to be SVG', bytes('image/svg+xml <svg/>')],
  ['SVGZ', gzipSync(bytes(svg('<rect width="10" height="10"/>')))],
])('[AC-F1-06v#1] only byte-recognized SVG / PNG are accepted: %s', (_name, input) => {
  expect(inspectPlatformIcon(input, options())).toEqual({
    ok: false,
    reason: 'icon_format_invalid',
  });
});

it.each(['', '\uFEFF', ' \n\t', '\uFEFF \n\t', '<?xml version="1.0" encoding="UTF-8"?>\n'])(
  '[AC-F1-06v#2] recognizes SVG bytes with allowed prologue %j',
  (prefix) => {
    const source = prefix + svg('<rect width="10" height="10"/>');
    expect(clean(source).documentElement.localName).toBe('svg');
  },
);

it('[AC-F1-06v#3] original size exactly maxBytes is allowed, one byte over is rejected', () => {
  const source = svg('<title>中文图标</title><rect width="1" height="1"/>');
  const input = bytes(source);
  success(inspectPlatformIcon(input, options(input.byteLength)), input);
  expect(inspectPlatformIcon(input, options(input.byteLength - 1))).toEqual({
    ok: false,
    reason: 'icon_too_large',
  });
});

it.each(['not an image', '<svg><broken', svg('<use href="https://invalid.example/icon.svg#x"/>')])(
  '[AC-F1-06v#4] original size is checked before format, parsing and conversion: %s',
  (source) => {
    const parser = vi.spyOn(xml.DOMParser.prototype, 'parseFromString');
    const remainingMs = vi.fn(() => -1);
    try {
      expect(inspect(source, { maxBytes: 1, deadline: { remainingMs } })).toEqual({
        ok: false,
        reason: 'icon_too_large',
      });
      expect(parser).not.toHaveBeenCalled();
      expect(remainingMs).not.toHaveBeenCalled();
    } finally {
      parser.mockRestore();
    }
  },
);

it.each([
  ['mismatched closing tag', '<svg xmlns="http://www.w3.org/2000/svg"><g></path></svg>'],
  ['duplicate attribute', svg('<rect x="1" x="2"/>')],
  ['unbound entity (xmldom error)', svg('<title>&undeclared;</title>')],
  ['non-svg root', '<?xml version="1.0"?><html/>'],
  ['multiple roots', '<svg/><svg/>'],
  ['internal DOCTYPE subset', '<!DOCTYPE svg [<!ELEMENT svg ANY>]><svg/>'],
  ['empty internal DOCTYPE subset', '<!DOCTYPE svg []><svg/>'],
  ['entity expansion', '<!DOCTYPE svg [<!ENTITY x "expanded">]><svg><title>&x;</title></svg>'],
  ['external entity', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///unreadable">]><svg/>'],
  ['other processing instruction', '<?xml version="1.0"?><?custom instruction?><svg/>'],
  ['nested processing instruction', svg('<?custom instruction?><path d="M0 0"/>')],
])('[AC-F1-06v#5] unparseable / disallowed XML is format-invalid: %s', (_name, source) => {
  expect(inspect(source)).toEqual({ ok: false, reason: 'icon_format_invalid' });
});

it.each([
  '<!DOCTYPE svg>',
  '<!DOCTYPE svg SYSTEM "https://never-fetch.invalid/svg.dtd">',
  '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "https://never-fetch.invalid/svg.dtd">',
])('[AC-F1-06v#6] accepts a DOCTYPE without an internal subset: %s', (doctype) => {
  const document = clean(`<?xml version="1.0"?>${doctype}${svg('<path d="M0 0L1 1"/>')}`);
  expect(document.getElementsByTagName('path')).toHaveLength(1);
});

it('[AC-F1-06v#7] xml-stylesheet is an unconvertible external stylesheet', () => {
  expect(
    inspect(`<?xml-stylesheet href="https://invalid.example/a.css"?>${svg('<rect/>')}`),
  ).toEqual({
    ok: false,
    reason: 'icon_svg_unconvertible',
  });
});
