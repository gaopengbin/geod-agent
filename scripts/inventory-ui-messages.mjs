import ts from '../apps/geod-agent-desktop/node_modules/typescript/lib/typescript.js';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve('apps/geod-agent-desktop/src');
const messages = new Map();
const walk = directory => fs.readdirSync(directory, {withFileTypes:true}).flatMap(item => item.isDirectory() ? walk(path.join(directory,item.name)) : [path.join(directory,item.name)]);
for (const file of walk(root).filter(file => /\.tsx?$/.test(file))) {
  const source = ts.createSourceFile(file, fs.readFileSync(file,'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  function visit(node) {
    if (ts.isJsxText(node) || ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const value = ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map((span,i)=>`{${i}}${span.literal.text}`).join('') : node.text;
      if (/[\u3400-\u9fff]/u.test(value)) {
        const key = value.trim().replace(/\s+/g,' ');
        const locations = messages.get(key) ?? [];
        locations.push({file:path.relative(root,file).replaceAll('\\','/'),line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1,kind:ts.SyntaxKind[node.kind]});
        messages.set(key,locations);
      }
    }
    ts.forEachChild(node,visit);
  }
  visit(source);
}
const inventory = [...messages].map(([text,locations])=>({text,locations}));
fs.mkdirSync('artifacts/product-gaps-20261004',{recursive:true});
fs.writeFileSync('artifacts/product-gaps-20261004/ui-message-inventory.json',JSON.stringify(inventory,null,2));
console.log(JSON.stringify({unique:inventory.length,tsx:inventory.filter(item=>item.locations.some(location=>location.file.endsWith('.tsx'))).length,jsxText:inventory.filter(item=>item.locations.some(location=>location.kind==='JsxText')).length,byFile:Object.fromEntries([...new Set(inventory.flatMap(item=>item.locations.map(location=>location.file)))].map(file=>[file,inventory.filter(item=>item.locations.some(location=>location.file===file)).length]))}));
