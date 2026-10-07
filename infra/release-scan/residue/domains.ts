/** 仅在 URL、完整引号/XML 文本、整行 KEY=value 三种上下文里认主机。 */
export function domainOccurrences(text: string): Array<{ offset: number; host: string }> {
  const found = new Map<number, string>();
  const add = (host: string, offset: number): void => {
    const labels = host.toLowerCase().split(/[.-]/);
    const ipv4 = host.split('.');
    const loopback =
      ipv4.length === 4 &&
      ipv4[0] === '127' &&
      ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
    if (
      labels.some((label) => ['staging', 'test', 'local', 'localhost'].includes(label)) ||
      loopback ||
      host === '10.0.2.2'
    )
      found.set(offset, host);
  };
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9+.-]*:\/\/([^\s/<>"'`\\\x00-\x1f?#]+)/g)) {
    const authority = match[1]!;
    const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
    const host = /^([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.?)(?::[0-9]+)?$/.exec(hostPort)?.[1];
    // React Router 用无端口、无业务路径的 localhost URL 作为解析基址。
    // 只排除该形态；带端口、业务路径、查询参数或凭据的 URL 仍参与检测。
    const suffix = /^[^\s<>"'`\\\x00-\x1f]*/.exec(text.slice(match.index + match[0].length))![0];
    if (
      host?.toLowerCase() === 'localhost' &&
      authority === host &&
      (suffix === '' || suffix === '/')
    )
      continue;
    if (host) add(host, match.index + match[0].length - hostPort.length);
  }
  const bare = (value: string, offset: number): void => {
    const host = /^([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\.?)(?::[0-9]+)?(?:\/[^\s]*)?$/.exec(
      value,
    )?.[1];
    if (!host) return;
    const tld = host.replace(/\.$/, '').split('.').at(-1)!;
    // 裸主机需有形似顶级域的末段；Material 的 ShapeAppearance.*.Test 等 PascalCase
    // 资源名不作域名。保留全大写域名、环境保留名与 IPv4 的原有检测。
    if (!/^(?:[a-z][A-Za-z]{1,62}|[A-Z]{2,63})$/.test(tld) && !/^\d+(?:\.\d+){3}$/.test(host))
      return;
    add(host, offset);
  };
  for (const match of text.matchAll(/(["'`])([^"'`\r\n]*)\1/g)) bare(match[2]!, match.index + 1);
  for (const match of text.matchAll(/>([^<\r\n]*)</g)) bare(match[1]!, match.index + 1);
  for (const match of text.matchAll(/^[\t ]*[A-Za-z_][A-Za-z0-9_]*=([^\r\n]+)\r?$/gm)) {
    bare(match[1]!, match.index + match[0].indexOf('=') + 1);
  }
  return [...found].map(([offset, host]) => ({ offset, host }));
}
