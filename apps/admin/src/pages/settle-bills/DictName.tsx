// 字典名或回退的编码：前后各留一个空格，读屏与复制时不和相邻单元格的数字、编码连成一串。
import type { ReactElement } from 'react';

export function DictName({ children }: { readonly children: string }): ReactElement {
  return <>{` ${children} `}</>;
}
