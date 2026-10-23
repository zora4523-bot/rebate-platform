import { expect, it } from 'vitest';
import { asset, sourceLines } from './kit.ts';

// B1-01zzm ledger ① defines these local AC identifiers. README section 1.4 is the operator's
// only instruction for the node public-key directory (exported by ops into /etc/couli-jwt-pub,
// D10-264); check the documented commands statically, never run them.
const PRIVATE_PEM = '/etc/couli-jwt/es256.pem';
const PRIVATE_KID = '/etc/couli-jwt/key-id';
const DIR = '/etc/couli-jwt-pub';
const PUBLIC_PEM = `${DIR}/es256.pub.pem`;
const PUBLIC_KID = `${DIR}/key-id`;
// End of one shell word: whitespace, a closing parenthesis or quote, or an operator.
const END = `(?=$|[\\s)'";|&])`;
// Start of a simple command, also after `(`, `&&`, `;` or `|`.
const START = '(?:^|[(&;|]\\s*)';

// Section 1.4 up to the next heading; `#` lines inside fenced code are shell comments.
function section(): string {
  const lines = asset('infra/staging/README.md').split(/\r?\n/);
  const start = lines.findIndex((line) => /^###\s+1\.4(?:\s|$)/.test(line));
  expect(start, 'README keeps section 1.4').toBeGreaterThanOrEqual(0);
  const body: string[] = [];
  let fenced = false;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && /^#{1,3}\s/.test(line)) break;
    body.push(line);
  }
  return [lines[start] ?? '', ...body].join('\n');
}

function commands(text: string): string[] {
  const blocks = [...text.matchAll(/^\s*```[^\n]*\n([\s\S]*?)^\s*```/gm)];
  return sourceLines(blocks.map((match) => match[1] ?? '').join('\n'));
}

function escape(path: string): string {
  return path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The path as a whole shell word (not a prefix of a longer path).
function names(line: string, path: string): boolean {
  return new RegExp(`(?:^|[\\s<>(='"])${escape(path)}${END}`).test(line);
}

function option(line: string, flag: string): boolean {
  return new RegExp(`\\s${flag}${END}`).test(line);
}

// openssl pkey / ec reading the existing signing key and printing or writing its public half.
function derivesPublicKey(line: string): boolean {
  return (
    /\bopenssl\s+(?:pkey|ec)\s/.test(line) &&
    option(line, '-pubout') &&
    new RegExp(`\\s-in\\s+${escape(PRIVATE_PEM)}${END}`).test(line)
  );
}

// A chown / chmod line covering `path`: listed itself, through `${DIR}/*`, or by -R on DIR.
function covers(lines: string[], command: RegExp, path: string): boolean {
  return lines.some(
    (line) =>
      command.test(line) &&
      (names(line, path) ||
        (path !== DIR && names(line, `${DIR}/*`)) ||
        (option(line, '-R') && names(line, DIR))),
  );
}

it('[AC-B1-01zzm-README#1] 1.4 写明由现有私钥导出公钥文件、复制 kid 到 /etc/couli-jwt-pub，属主 1000、目录 500、文件 400', () => {
  const text = section();
  const lines = commands(text);
  expect(text).toContain(DIR);
  expect(text).toMatch(/\bstream\b/);
  expect(text).toContain('JWT_PUBLIC_KEY_PEM');
  expect(text, 'name the file format the verifier accepts').toMatch(/SPKI|BEGIN PUBLIC KEY/);
  expect(text, 'the api signing-key instructions stay').toContain('JWT_PRIVATE_KEY_PEM');
  const create = new RegExp(`${START}(?:install\\s(?:.*\\s)?-d|mkdir)\\s`);
  expect(
    lines.some((line) => create.test(line) && names(line, DIR)),
    `create ${DIR}`,
  ).toBe(true);
  const written = new RegExp(`(?:\\s-out\\s+|>\\s*)${escape(PUBLIC_PEM)}${END}`);
  expect(
    lines.some((line) => derivesPublicKey(line) && written.test(line)),
    'derive the public key from the existing private key straight into the file',
  ).toBe(true);
  const copy = new RegExp(`${START}(?:cp|install|cat)\\s`);
  expect(
    lines.some((line) => copy.test(line) && names(line, PRIVATE_KID) && names(line, PUBLIC_KID)),
    'key-id is a copy of the signing key id',
  ).toBe(true);
  const chown = new RegExp(`${START}chown\\s+(?:-R\\s+)?1000:1000\\s`);
  for (const path of [DIR, PUBLIC_PEM, PUBLIC_KID]) {
    expect(covers(lines, chown, path), `${path} owned by uid 1000`).toBe(true);
  }
  const fileMode = new RegExp(`${START}chmod\\s+0?400\\s`);
  expect(covers(lines, fileMode, PUBLIC_PEM), `${PUBLIC_PEM} mode 400`).toBe(true);
  expect(covers(lines, fileMode, PUBLIC_KID), `${PUBLIC_KID} mode 400`).toBe(true);
  const directoryMode = new RegExp(`${START}chmod\\s+0?500\\s`);
  expect(
    lines.some((line) => directoryMode.test(line) && names(line, DIR)),
    `${DIR} mode 500`,
  ).toBe(true);
});

it('[AC-B1-01zzm-README#2] 1.4 写明核对：公钥与现有私钥对应、两份 kid 一致、公钥文件按公钥解析；任何命令都不打印私钥', () => {
  const lines = commands(section());
  const compare = /\b(?:cmp|diff)\s/;
  const digest = /\b(?:sha256sum|sha1sum|md5sum|openssl\s+dgst)\b/;
  const compared = lines.some(
    (line) => compare.test(line) && derivesPublicKey(line) && names(line, PUBLIC_PEM),
  );
  const fingerprinted =
    lines.some((line) => digest.test(line) && derivesPublicKey(line)) &&
    lines.some((line) => digest.test(line) && names(line, PUBLIC_PEM) && !derivesPublicKey(line));
  expect(compared || fingerprinted, `${PUBLIC_PEM} matches the key in ${PRIVATE_PEM}`).toBe(true);
  expect(
    lines.some((line) => compare.test(line) && names(line, PRIVATE_KID) && names(line, PUBLIC_KID)),
    'compare the two key-id files',
  ).toBe(true);
  const parsed = (line: string): boolean =>
    /\bopenssl\s+(?:pkey|ec)\s/.test(line) && option(line, '-pubin') && names(line, PUBLIC_PEM);
  expect(lines.some(parsed), `parse ${PUBLIC_PEM} as a public key (shows the curve)`).toBe(true);
  // Never print the private key: no dump of it, and every openssl reading it writes a file,
  // prints only the public half, or prints nothing.
  for (const line of lines.filter((item) => names(item, PRIVATE_PEM))) {
    expect(line).not.toMatch(/\b(?:cat|head|tail|less|more|xxd|od|base64|strings|tee)\s/);
    if (!/\bopenssl\s/.test(line)) continue;
    expect(option(line, '-text'), line).toBe(false);
    expect(
      option(line, '-pubout') ||
        option(line, '-text_pub') ||
        option(line, '-noout') ||
        /\s-out\s+\S/.test(line),
      line,
    ).toBe(true);
  }
});
