// 契约默认字典（contracts/texts.default.json）经 `?h5-texts&lang.json` 后缀导入时的类型（F1-01t；
// `lang.json` 让 Vite 仍按 JSON 处理带查询的导入）。
// 带后缀的导入让 JSON 留在本包 TypeScript 工程之外；构建时由 apps/h5/build/trim-texts-plugin.ts
// 换成按引用裁剪后的子集，开发服务器与 Vitest 照旧读完整字典。
declare module '*/contracts/texts.default.json?h5-texts&lang.json' {
  const dictionary: {
    texts: Record<string, string>;
    fallbacks: Record<string, string>;
  };
  export default dictionary;
}
