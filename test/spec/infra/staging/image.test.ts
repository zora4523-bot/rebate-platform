import { expect, it } from 'vitest';
import { asset, noInlineCredentials, sourceLines } from './kit.ts';

it('[AC-B1-01zc-IMAGE#1] 多阶段镜像基于 Node 24，最终阶段以非 root 用户运行', () => {
  const lines = sourceLines(asset('infra/staging/Dockerfile'));
  const from = lines.filter((line) => /^FROM\s/i.test(line));
  expect(from.length).toBeGreaterThanOrEqual(2);
  const aliases = new Set<string>();
  for (const line of from) {
    const match = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?$/i.exec(line);
    expect(match, line).not.toBeNull();
    const base = match?.[1] ?? '';
    expect(
      /^node:24(?:\.\d+\.\d+)?(?:-[\w.-]+)?(?:@sha256:[a-f0-9]{64})?$/.test(base) ||
        aliases.has(base),
    ).toBe(true);
    if (match?.[2]) aliases.add(match[2]);
  }
  const finalStage = lines.slice(lines.lastIndexOf(from.at(-1) ?? ''));
  const user = finalStage.filter((line) => /^USER\s/i.test(line)).at(-1) ?? '';
  expect(user).toMatch(/^USER\s+[a-z_0-9][\w.-]*(?::[a-z_0-9][\w.-]*)?$/i);
  const identity = user.replace(/^USER\s+/i, '').split(':')[0] ?? '';
  expect(identity).not.toMatch(/^(?:root|0+)$/i);
  expect(finalStage.some((line) => /^(?:CMD|ENTRYPOINT)\s/i.test(line))).toBe(true);
});

it('[AC-B1-01zc-IMAGE#2] 构建使用锁文件和离线依赖，并构建后端产物', () => {
  const lines = sourceLines(asset('infra/staging/Dockerfile'));
  const runs = lines.filter((line) => /^RUN\s/i.test(line)).join('\n');
  expect(runs).toMatch(/\bpnpm\b[^\n]*\b(?:fetch|install)\b[^\n]*--frozen-lockfile\b/);
  expect(runs).toMatch(/\bpnpm\b[^\n]*\binstall\b[^\n]*--offline\b/);
  expect(runs).toMatch(/\b(?:pnpm\b[^\n]*\bbuild|tsc\s+-b)\b/);
  expect(lines.some((line) => /^COPY\s/i.test(line) && /pnpm-lock\.yaml/.test(line))).toBe(true);
  expect(lines.some((line) => /^COPY\s+--from=/.test(line))).toBe(true);
});

it('[AC-B1-01zc-IMAGE#3] 镜像不复制环境文件、不内联凭据', () => {
  const text = asset('infra/staging/Dockerfile');
  const lines = sourceLines(text);
  const copies = lines.filter((line) => /^(?:COPY|ADD)\s/i.test(line));
  expect(copies.length).toBeGreaterThan(0);
  for (const line of copies) {
    expect(line).not.toMatch(
      /(?:^|[\s/"'])\.env(?:[\s/"'.*]|$)|\/etc\/couli|staging(?:-payout|-migrator)?\.env/i,
    );
  }
  noInlineCredentials(text);
  expect(lines.join('\n')).not.toMatch(
    /^(?:ARG|ENV)\s+\w*(?:PASSWORD|SECRET|TOKEN|DATABASE_URL|REDIS_URL)\b/im,
  );
});
