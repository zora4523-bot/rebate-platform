import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { COPY } from './copy.ts';

// 03 §9.1 and the F1 frontend lessons: the upload and registration dialogs are built from antd
// components rendered as JSX (Upload, Modal, Form, Input, DatePicker, Checkbox, Alert, Button),
// the version history pages with antd Pagination, the copy lives in texts/platform-icons.ts, and
// the page never reads the chosen file itself: the preview is the server's cleaned file
// (BR-TEXT-24 细则「显示上下文」). The frozen F1-06zd source test keeps banning native controls,
// handwritten antd class names, HTML sinks and direct fetch in the same directory.
const admin = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../apps/admin/src');
const root = join(admin, 'pages/platform-icons');

function files(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

function visit(node: ts.Node, inspect: (node: ts.Node) => void): void {
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function sources(): ts.SourceFile[] {
  return files(root)
    .filter((path) => /\.tsx?$/.test(path) && !/\.(?:test|gen|d)\.tsx?$/.test(path))
    .map(parse);
}

/** Local value bindings of `imported` from 'antd' (named, aliased or namespace import). */
function antdBindings(file: ts.SourceFile, imported: string): Set<string> {
  const names = new Set<string>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      statement.importClause?.isTypeOnly ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== 'antd'
    )
      continue;
    const named = statement.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const item of named.elements)
        if (!item.isTypeOnly && (item.propertyName ?? item.name).text === imported)
          names.add(item.name.text);
    } else if (named && ts.isNamespaceImport(named)) {
      names.add(`${named.name.text}.${imported}`);
    }
  }
  return names;
}

/** antd components (by imported name) rendered as JSX in `file`, including `X.Sub` tags. */
function renderedAntd(file: ts.SourceFile, components: readonly string[]): Set<string> {
  const bound = new Map<string, string>();
  for (const component of components)
    for (const name of antdBindings(file, component)) bound.set(name, component);
  const rendered = new Set<string>();
  visit(file, (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(file);
      for (const [name, component] of bound)
        if (tag === name || tag.startsWith(`${name}.`)) rendered.add(component);
    }
  });
  return rendered;
}

const UPLOAD_COMPONENTS = [
  'Upload',
  'Modal',
  'Form',
  'Input',
  'DatePicker',
  'Checkbox',
  'Alert',
  'Button',
] as const;

it('[AC-F1-06ze-SOURCE#1] 上传与补登来源用 antd Upload、Modal、Form、Input、DatePicker、Checkbox、Alert、Button，不自己读取所选文件', () => {
  const rendered = new Set<string>();
  const violations: string[] = [];
  for (const file of sources()) {
    for (const component of renderedAntd(file, UPLOAD_COMPONENTS)) rendered.add(component);
    const location = (node: ts.Node) =>
      `${relative(root, file.fileName)}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
    visit(file, (node) => {
      // The preview is the server's cleaned file: no local reading or object URL of the original.
      if (ts.isIdentifier(node) && /^(?:FileReader|createObjectURL)$/.test(node.text))
        violations.push(`${location(node)}: ${node.text}`);
      if (
        ts.isPropertyAccessExpression(node) &&
        /^(?:arrayBuffer|readAsDataURL|readAsText)$/.test(node.name.text)
      )
        violations.push(`${location(node)}: reads the chosen file (${node.name.text})`);
      // A file chooser only through antd Upload: no handwritten input of type file.
      if (
        ts.isJsxAttribute(node) &&
        node.name.getText(file) === 'type' &&
        node.initializer !== undefined &&
        ts.isStringLiteral(node.initializer) &&
        node.initializer.text === 'file'
      )
        violations.push(`${location(node)}: type="file"`);
    });
  }
  // Positive part first: the current page renders none of the upload controls.
  expect([...rendered].sort(), 'pages/platform-icons renders these antd components').toEqual(
    [...UPLOAD_COMPONENTS].sort(),
  );
  expect(violations).toEqual([]);
});

it('[AC-F1-06ze-SOURCE#2] 上传、清洗预览、来源登记与错误提示的文案在 texts/platform-icons.ts', () => {
  const texts = readFileSync(join(admin, 'texts/platform-icons.ts'), 'utf8');
  const literal = (sentence: string) => texts.includes(sentence);
  const required = [
    COPY.requirements,
    COPY.rule1,
    COPY.rule2,
    COPY.rule3,
    COPY.noFile,
    COPY.choose,
    COPY.upload,
    COPY.uploading,
    COPY.discard,
    COPY.reselect,
    COPY.sanitizedBody,
    COPY.previewTitle,
    COPY.confirm,
    COPY.confirmHint,
    COPY.sourceHelp,
    COPY.draftNote,
    COPY.save,
    COPY.failedTag,
    COPY.notUploaded,
    COPY.formatInvalid,
    COPY.tooLarge,
    COPY.unconvertible,
    COPY.uploadExpired,
    COPY.unconfirmed,
    COPY.unknownKey,
    COPY.saveRegister,
    COPY.versionNotEditable,
    '来源页地址（发布前必填）',
    '下载日期（发布前必填）',
  ];
  expect(required.filter((sentence) => !literal(sentence))).toEqual([]);
  // The F1-06zd placeholder for the missing upload is gone.
  expect(texts.includes('上传与来源登记功能暂未开放')).toBe(false);
});

it('[AC-F1-06ze-SOURCE#3] 版本历史渲染从 antd 导入的 Pagination', () => {
  const rendered = sources().filter((file) => renderedAntd(file, ['Pagination']).size > 0);
  expect(
    rendered.map((file) => relative(root, file.fileName)),
    'a file of pages/platform-icons renders antd Pagination',
  ).not.toEqual([]);
  // The file that renders the history Drawer is one of them (the pager sits in the drawer).
  const drawers = sources().filter((file) => renderedAntd(file, ['Drawer']).size > 0);
  expect(drawers.length).toBeGreaterThan(0);
  const pagerFiles = new Set(rendered.map((file) => file.fileName));
  const drawerImports = drawers.flatMap((file) =>
    file.statements.flatMap((statement) =>
      ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
        ? [resolve(dirname(file.fileName), statement.moduleSpecifier.text)]
        : [],
    ),
  );
  expect(
    drawers.some(
      (file) => pagerFiles.has(file.fileName) || drawerImports.some((path) => pagerFiles.has(path)),
    ),
    'the drawer file renders Pagination or imports the file that does',
  ).toBe(true);
});
