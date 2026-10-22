// H5 字典按引用裁剪的 Vite 构建插件（F1-01t）。只在 `vite build` 时生效：shared/texts.ts 经
// `texts.default.json?h5-texts&lang.json` 导入的契约字典被替换为收集器选出的子集（整个 src 共用一份），并把同一对象
// 输出为 trim-texts.json 供核对。开发服务器与 Vitest 不加载本插件，照旧拿到完整字典。
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { collectH5Texts, type TrimTextDictionary } from './trim-texts.ts';

/** shared/texts.ts 导入契约字典时带的查询后缀；插件只替换带这个后缀的导入。 */
export const TRIM_TEXTS_QUERY = 'h5-texts';
/** 构建产物里核对用的替换字典文件名。 */
export const TRIM_TEXTS_MANIFEST = 'trim-texts.json';

export interface TrimTextsPluginOptions {
  /** apps/h5/src 的绝对路径（收集范围）。 */
  sourceRoot: string;
  /** contracts/texts.default.json 的绝对路径。 */
  dictionaryFile: string;
}

function splitId(id: string): { file: string; query: string } {
  const at = id.indexOf('?');
  return at < 0 ? { file: id, query: '' } : { file: id.slice(0, at), query: id.slice(at + 1) };
}

export function trimTextsPlugin(options: TrimTextsPluginOptions): Plugin {
  let trimmed: TrimTextDictionary | undefined;
  return {
    name: 'couli:h5-trim-texts',
    apply: 'build',
    enforce: 'pre',
    buildStart() {
      // 每次构建重新收集；漏登记的动态键在这里抛错，构建失败。
      const dictionary = JSON.parse(
        readFileSync(options.dictionaryFile, 'utf8'),
      ) as TrimTextDictionary;
      trimmed = collectH5Texts({ sourceRoot: options.sourceRoot, dictionary });
    },
    load(id) {
      const { file, query } = splitId(id);
      if (file !== options.dictionaryFile) return undefined;
      if (!new URLSearchParams(query).has(TRIM_TEXTS_QUERY)) {
        // 不带后缀的导入会把整份字典打进包：拒绝，让问题在构建期暴露。
        this.error(
          `apps/h5: contracts/texts.default.json 只能经 shared/texts.ts 的 ?${TRIM_TEXTS_QUERY} 导入（${id}）`,
        );
      }
      if (trimmed === undefined) this.error('apps/h5: 字典裁剪结果尚未生成');
      // 仍以 JSON 文本交给 Vite 的 JSON 处理，导出形状与直接导入 JSON 一致。
      return JSON.stringify(trimmed);
    },
    generateBundle() {
      if (trimmed === undefined) this.error('apps/h5: 字典裁剪结果尚未生成');
      this.emitFile({
        type: 'asset',
        fileName: TRIM_TEXTS_MANIFEST,
        source: JSON.stringify(trimmed),
      });
    },
  };
}
